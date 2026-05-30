export type Status = 0 | 1 | 2 | 3 | 4;
export type Priority = 0 | 1 | 2 | 3;
export type Tag = 1 | 2 | 3;

export interface SerializedNode {
  path: string;
  name: string;
  collapsed: boolean;
  status: Status;
  priority: Priority;
  tags: Tag[];
  children: SerializedNode[];
}

export interface DocumentStateMessage {
  type: 'document';
  tree: SerializedNode;
  zoom: number;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type ExportPngMode = 'expanded' | 'current';

export interface ExportPngRequestMessage {
  type: 'requestExportPng';
  requestId: string;
  expandMode: ExportPngMode;
}

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'zoomChanged'; zoom: number }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'exportPng' }
  | { type: 'copyNodeText'; path: string }
  | { type: 'pasteNodeText'; path: string }
  | { type: 'setName'; path: string; name: string }
  | { type: 'addChild'; path: string }
  | { type: 'addSibling'; path: string; position: 'before' | 'after' }
  | { type: 'reparentNode'; path: string; targetPath: string }
  | { type: 'reparentNodes'; paths: string[]; targetPath: string }
  | { type: 'toggleCollapse'; path: string }
  | { type: 'deleteNode'; path: string }
  | { type: 'setStatus'; path: string; status: Status }
  | { type: 'toggleTag'; path: string; tag: Tag }
  | { type: 'setPriority'; path: string; priority: Priority }
  | { type: 'moveNode'; path: string; direction: 'up' | 'down' }
  | { type: 'exportPngResult'; requestId: string; dataUrl: string }
  | { type: 'exportPngError'; requestId: string; message: string };

export type OperationResult =
  | { selectedPath?: string; selectedPaths?: string[]; editPath?: string }
  | undefined;
