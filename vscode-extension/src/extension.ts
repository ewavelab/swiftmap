import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { applyWebviewMessage, getNodeByPath, parseDocument, parsePath, serializeForWebview } from './documentOps';
import type { DocumentStateMessage, ErrorMessage, ExportPngMode, ExportPngRequestMessage, WebviewMessage } from './protocol';


export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(SwiftMapEditorProvider.register(context));

  context.subscriptions.push(
    vscode.commands.registerCommand('swiftmap.newDocument', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'swiftmap',
        content: '+ [] Root',
      });
      await vscode.window.showTextDocument(doc, { preview: false });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('swiftmap.openSource', async (uri?: vscode.Uri) => {
      const targetUri = uri ?? getActiveSwiftMapUri();
      if (!targetUri) {
        void vscode.window.showErrorMessage('No SwiftMap document is currently active.');
        return;
      }

      await vscode.commands.executeCommand(
        'vscode.openWith',
        targetUri,
        'default',
        vscode.window.activeTextEditor?.viewColumn,
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('swiftmap.openVisualEditor', async (uri?: vscode.Uri) => {
      const targetUri = uri ?? getActiveSwiftMapUri();
      if (!targetUri) {
        void vscode.window.showErrorMessage('No SwiftMap document is currently active.');
        return;
      }

      await vscode.commands.executeCommand(
        'vscode.openWith',
        targetUri,
        SwiftMapEditorProvider.viewType,
        vscode.window.activeTextEditor?.viewColumn,
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('swiftmap.exportPng', async (uri?: vscode.Uri) => {
      const targetUri = uri ?? getActiveSwiftMapUri();
      if (!targetUri) {
        void vscode.window.showErrorMessage('No SwiftMap document is currently active.');
        return;
      }

      await SwiftMapEditorProvider.exportPng(targetUri);
    }),
  );
}

export function deactivate(): void {}

function getActiveSwiftMapUri(): vscode.Uri | undefined {
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (activeTab?.input instanceof vscode.TabInputCustom) {
    return activeTab.input.uri;
  }
  return vscode.window.activeTextEditor?.document.uri;
}

class SwiftMapEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'swiftmap.editor';
  private static readonly panels = new Map<string, vscode.WebviewPanel>();
  private static zoomLevel = 1;
  private static instance: SwiftMapEditorProvider | undefined;

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new SwiftMapEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(SwiftMapEditorProvider.viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  public static async exportPng(uri: vscode.Uri): Promise<void> {
    const panel = SwiftMapEditorProvider.panels.get(uri.toString());
    if (!panel) {
      void vscode.window.showErrorMessage('Open the visual editor before exporting the map.');
      return;
    }

    if (!SwiftMapEditorProvider.instance) {
      void vscode.window.showErrorMessage('SwiftMap exporter is not available.');
      return;
    }

    await SwiftMapEditorProvider.instance.exportPanelPng(uri, panel);
  }

  private constructor(private readonly context: vscode.ExtensionContext) {
    SwiftMapEditorProvider.instance = this;
    SwiftMapEditorProvider.zoomLevel = Math.min(2.2, Math.max(0.35, context.globalState.get<number>('swiftmap.zoom', 1)));
  }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);
    SwiftMapEditorProvider.panels.set(document.uri.toString(), webviewPanel);

    const updateWebview = () => {
      try {
        const parsed = parseDocument(document.getText());
        const tree = serializeForWebview(parsed.root, '0');
        const message: DocumentStateMessage = { type: 'document', tree, zoom: SwiftMapEditorProvider.zoomLevel };
        void webviewPanel.webview.postMessage(message);
      } catch (error) {
        const message: ErrorMessage = {
          type: 'error',
          message: error instanceof Error ? error.message : 'Failed to parse SwiftMap document.',
        };
        void webviewPanel.webview.postMessage(message);
      }
    };

    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() === document.uri.toString()) {
        updateWebview();
      }
    });

    const messageSubscription = webviewPanel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      try {
        switch (message.type) {
          case 'ready':
            updateWebview();
            return;
          case 'zoomChanged':
            SwiftMapEditorProvider.zoomLevel = Math.min(2.2, Math.max(0.35, message.zoom));
            void this.context.globalState.update('swiftmap.zoom', SwiftMapEditorProvider.zoomLevel);
            return;
          case 'undo':
            await vscode.commands.executeCommand('undo');
            return;
          case 'redo':
            await vscode.commands.executeCommand('redo');
            return;
          case 'exportPng':
            await this.exportPanelPng(document.uri, webviewPanel);
            return;
          case 'exportPngResult':
          case 'exportPngError':
            return;
          case 'copyNodeText': {
            const node = getNodeByPath(parseDocument(document.getText()).root, parsePath(message.path));
            await vscode.env.clipboard.writeText(node.name);
            return;
          }
          case 'pasteNodeText': {
            const text = await vscode.env.clipboard.readText();
            const result = await applyWebviewMessage(document, {
              type: 'setName',
              path: message.path,
              name: text,
            });
            if (result) {
              await webviewPanel.webview.postMessage({ type: 'operationResult', ...result });
            }
            return;
          }
          default: {
            const result = await applyWebviewMessage(document, message);
            if (result) {
              await webviewPanel.webview.postMessage({ type: 'operationResult', ...result });
            }
            return;
          }
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : 'SwiftMap operation failed.';
        void vscode.window.showErrorMessage(text);
        await webviewPanel.webview.postMessage({ type: 'operationError', message: text });
      }
    });

    webviewPanel.onDidDispose(() => {
      SwiftMapEditorProvider.panels.delete(document.uri.toString());
      changeDocumentSubscription.dispose();
      messageSubscription.dispose();
    });
  }

  private getHtml(_webview: vscode.Webview): string {
    const csp = [
      "default-src 'none'",
      `style-src ${_webview.cspSource}`,
      `script-src ${_webview.cspSource}`,
      'img-src data:',
    ].join('; ');

    const templatePath = path.join(this.context.extensionPath, 'resources', 'webview', 'index.html');
    const styleUri = _webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'webview', 'styles.css')));
    const scriptUri = _webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'webview', 'main.js')));
    const html = fs.readFileSync(templatePath, 'utf8');
    return html
      .replace('__CSP__', csp)
      .replace('__STYLE_URI__', styleUri.toString())
      .replace('__SCRIPT_URI__', scriptUri.toString());
  }

  private async exportPanelPng(uri: vscode.Uri, panel: vscode.WebviewPanel): Promise<void> {
    const expandMode = await vscode.window.showQuickPick(
      [
        {
          label: 'Expand all nodes',
          description: 'Default export mode',
          value: 'expanded' as const,
        },
        {
          label: 'Use current expand state',
          description: 'Keep collapsed nodes collapsed in the export',
          value: 'current' as const,
        },
      ],
      {
        title: 'Export SwiftMap as PNG',
        placeHolder: 'Choose how nodes should be expanded in the exported image',
      },
    );
    if (!expandMode) {
      return;
    }

    const baseName = uri.scheme === 'file' ? path.basename(uri.fsPath, path.extname(uri.fsPath)) : 'swiftmap';
    const defaultDirectory = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? (uri.scheme === 'file' ? path.dirname(uri.fsPath) : process.cwd());
    const defaultUri = vscode.Uri.file(path.join(defaultDirectory, `${baseName}.png`));
    const saveUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { PNG: ['png'] },
      saveLabel: 'Export PNG',
    });
    if (!saveUri) {
      return;
    }

    const dataUrl = await this.requestExportPng(panel, expandMode.value);
    const buffer = decodeDataUrl(dataUrl);
    await fs.promises.writeFile(saveUri.fsPath, buffer);
    void vscode.window.showInformationMessage(`Exported PNG to ${saveUri.fsPath}`);
  }

  private requestExportPng(panel: vscode.WebviewPanel, expandMode: ExportPngMode): Promise<string> {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const request: ExportPngRequestMessage = {
      type: 'requestExportPng',
      requestId,
      expandMode,
    };

    return new Promise<string>((resolve, reject) => {
      const disposable = panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
        if (message.type === 'exportPngResult' && message.requestId === requestId) {
          disposable.dispose();
          resolve(message.dataUrl);
        } else if (message.type === 'exportPngError' && message.requestId === requestId) {
          disposable.dispose();
          reject(new Error(message.message));
        }
      });

      void panel.webview.postMessage(request).then((posted) => {
        if (!posted) {
          disposable.dispose();
          reject(new Error('Failed to start PNG export.'));
        }
      }, (error) => {
        disposable.dispose();
        reject(error instanceof Error ? error : new Error('Failed to start PNG export.'));
      });
    });
  }
}

function decodeDataUrl(dataUrl: string): Buffer {
  const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
  if (!match) {
    throw new Error('Export did not produce a PNG image.');
  }
  return Buffer.from(match[1], 'base64');
}
