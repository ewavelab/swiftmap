import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { applyWebviewMessage, getNodeByPath, parseDocument, parsePath, serializeForWebview } from './documentOps';
import type { DocumentStateMessage, ErrorMessage, WebviewMessage } from './protocol';


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

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new SwiftMapEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(SwiftMapEditorProvider.viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  private constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    const updateWebview = () => {
      try {
        const parsed = parseDocument(document.getText());
        const tree = serializeForWebview(parsed.root, '0');
        const message: DocumentStateMessage = { type: 'document', tree };
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
          case 'undo':
            await vscode.commands.executeCommand('undo');
            return;
          case 'redo':
            await vscode.commands.executeCommand('redo');
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
}
