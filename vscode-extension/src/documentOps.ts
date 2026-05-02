import * as vscode from 'vscode';
import type { Flag, OperationResult, SerializedNode, WebviewMessage } from './protocol';

export interface MindMapNode {
  name: string;
  collapsed: boolean;
  flags: Flag[];
  children: MindMapNode[];
}

export interface ParsedDocument {
  root: MindMapNode;
}

export function parseDocument(text: string): ParsedDocument {
  const lines = text.length === 0 ? ['+ [] Root'] : text.replace(/\r/g, '').split('\n');
  const stack: Array<{ indent: number; node: MindMapNode }> = [];
  let root: MindMapNode | undefined;

  for (const rawLine of lines) {
    if (rawLine.trim().length === 0) {
      continue;
    }
    const indentMatch = rawLine.match(/^\s*/);
    const indentText = indentMatch ? indentMatch[0] : '';
    const indent = indentText.replace(/\t/g, '  ').length;
    const content = rawLine.slice(indentText.length);
    const match = content.match(/^([+-])\s+(\[(?:Done|Rejected|Question|Task|Idea|Low priority|Medium priority|High priority)?(?:,(?:Done|Rejected|Question|Task|Idea|Low priority|Medium priority|High priority))*\])\s?(.*)$/);
    if (!match) {
      throw new Error(`Invalid SwiftMap line: "${rawLine}"`);
    }

    const collapsed = match[1] === '-';
    const flags = parseFlags(match[2]);
    const name = sanitizeName(match[3]);
    const node: MindMapNode = {
      name,
      collapsed,
      flags,
      children: [],
    };

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    if (!root) {
      if (indent !== 0) {
        throw new Error('Root node must not be indented.');
      }
      root = node;
      stack.push({ indent, node });
      continue;
    }

    const parentEntry = stack[stack.length - 1];
    if (!parentEntry) {
      throw new Error(`Invalid indentation near "${rawLine}"`);
    }

    parentEntry.node.children.push(node);
    stack.push({ indent, node });
  }

  if (!root) {
    root = {
      name: 'Root',
      collapsed: false,
      flags: [],
      children: [],
    };
  }

  return { root };
}

export function parsePath(path: string): number[] {
  if (path === '0') {
    return [];
  }
  const parts = path.split('.').slice(1);
  return parts.map((part) => {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Invalid path "${path}"`);
    }
    return value;
  });
}

export function serializeDocument(root: MindMapNode): string {
  const lines: string[] = [];

  const visit = (node: MindMapNode, depth: number) => {
    const indent = '  '.repeat(depth);
    const status = node.collapsed ? '-' : '+';
    const flags = node.flags.length > 0 ? `[${node.flags.map(formatFlag).join(',')}]` : '[]';
    lines.push(`${indent}${status} ${flags} ${sanitizeName(node.name)}`);
    for (const child of node.children) {
      visit(child, depth + 1);
    }
  };

  visit(root, 0);
  return lines.join('\n');
}

export function serializeForWebview(node: MindMapNode, path: string): SerializedNode {
  return {
    path,
    name: node.name,
    collapsed: node.collapsed,
    flags: [...node.flags],
    children: node.children.map((child, index) => serializeForWebview(child, `${path}.${index}`)),
  };
}

export function getNodeByPath(root: MindMapNode, path: number[]): MindMapNode {
  let current = root;
  for (const index of path) {
    const next = current.children[index];
    if (!next) {
      throw new Error('Selected node no longer exists.');
    }
    current = next;
  }
  return current;
}

export async function applyWebviewMessage(
  document: vscode.TextDocument,
  message: Exclude<WebviewMessage, { type: 'ready' | 'undo' | 'redo' | 'exportPng' | 'exportPngResult' | 'exportPngError' }>,
): Promise<OperationResult> {
  const parsed = parseDocument(document.getText());
  const path = 'path' in message ? parsePath(message.path) : [];

  let result: OperationResult;
  switch (message.type) {
    case 'setName':
      getNodeByPath(parsed.root, path).name = sanitizeName(message.name);
      result = { selectedPath: message.path };
      break;
    case 'addChild': {
      const parent = getNodeByPath(parsed.root, path);
      parent.collapsed = false;
      const childIndex = parent.children.length;
      parent.children.push({
        name: '',
        collapsed: false,
        flags: [],
        children: [],
      });
      result = { selectedPath: `${message.path}.${childIndex}`, editPath: `${message.path}.${childIndex}` };
      break;
    }
    case 'addSibling': {
      if (path.length === 0) {
        throw new Error('Root node cannot have sibling nodes added.');
      }
      const parentPath = path.slice(0, -1);
      const parent = getNodeByPath(parsed.root, parentPath);
      parent.collapsed = false;
      const currentIndex = path[path.length - 1];
      const insertIndex = message.position === 'before' ? currentIndex : currentIndex + 1;
      parent.children.splice(insertIndex, 0, {
        name: '',
        collapsed: false,
        flags: [],
        children: [],
      });
      const nextPath = formatPath([...parentPath, insertIndex]);
      result = { selectedPath: nextPath, editPath: nextPath };
      break;
    }
    case 'reparentNode': {
      if (path.length === 0) {
        throw new Error('Root node cannot be moved.');
      }
      const targetPath = parsePath(message.targetPath);
      if (pathsEqual(path, targetPath)) {
        throw new Error('A node cannot be dropped onto itself.');
      }
      if (isDescendantPath(targetPath, path)) {
        throw new Error('A node cannot be moved into its own subtree.');
      }

      const sourceParent = getNodeByPath(parsed.root, path.slice(0, -1));
      const sourceIndex = path[path.length - 1];
      const movingNode = sourceParent.children[sourceIndex];
      if (!movingNode) {
        throw new Error('Selected node no longer exists.');
      }

      const targetNode = getNodeByPath(parsed.root, targetPath);
      targetNode.collapsed = false;
      sourceParent.children.splice(sourceIndex, 1);
      targetNode.children.push(movingNode);

      const movedPath = findPathToNode(parsed.root, movingNode);
      if (!movedPath) {
        throw new Error('Failed to locate moved node.');
      }
      result = { selectedPath: formatPath(movedPath) };
      break;
    }
    case 'reparentNodes': {
      const sourcePaths = message.paths.map(parsePath);
      if (sourcePaths.length === 0) {
        throw new Error('No nodes selected.');
      }
      if (sourcePaths.some((sourcePath) => sourcePath.length === 0)) {
        throw new Error('Root node cannot be moved.');
      }

      const targetPath = parsePath(message.targetPath);
      for (const sourcePath of sourcePaths) {
        if (pathsEqual(sourcePath, targetPath)) {
          throw new Error('A node cannot be dropped onto itself.');
        }
        if (isDescendantPath(targetPath, sourcePath)) {
          throw new Error('A node cannot be moved into its own subtree.');
        }
      }
      for (let leftIndex = 0; leftIndex < sourcePaths.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < sourcePaths.length; rightIndex += 1) {
          if (isDescendantPath(sourcePaths[leftIndex], sourcePaths[rightIndex]) || isDescendantPath(sourcePaths[rightIndex], sourcePaths[leftIndex])) {
            throw new Error('Selected nodes cannot contain one another.');
          }
        }
      }

      const movingEntries = sourcePaths.map((sourcePath) => {
        const sourceParent = getNodeByPath(parsed.root, sourcePath.slice(0, -1));
        const sourceIndex = sourcePath[sourcePath.length - 1];
        const movingNode = sourceParent.children[sourceIndex];
        if (!movingNode) {
          throw new Error('Selected node no longer exists.');
        }
        return { path: sourcePath, parent: sourceParent, node: movingNode };
      });

      const targetNode = getNodeByPath(parsed.root, targetPath);
      const movingNodes = movingEntries
        .slice()
        .sort((left, right) => comparePaths(left.path, right.path))
        .map((entry) => entry.node);

      for (const entry of movingEntries) {
        const currentIndex = entry.parent.children.indexOf(entry.node);
        if (currentIndex < 0) {
          throw new Error('Selected node no longer exists.');
        }
        entry.parent.children.splice(currentIndex, 1);
      }

      targetNode.collapsed = false;
      targetNode.children.push(...movingNodes);

      const movedPaths = movingNodes.map((movingNode) => {
        const movedPath = findPathToNode(parsed.root, movingNode);
        if (!movedPath) {
          throw new Error('Failed to locate moved node.');
        }
        return formatPath(movedPath);
      });
      result = { selectedPath: movedPaths[0], selectedPaths: movedPaths };
      break;
    }
    case 'toggleCollapse': {
      const node = getNodeByPath(parsed.root, path);
      node.collapsed = !node.collapsed;
      result = { selectedPath: message.path };
      break;
    }
    case 'deleteNode': {
      if (path.length === 0) {
        throw new Error('Root node cannot be deleted.');
      }
      const parent = getNodeByPath(parsed.root, path.slice(0, -1));
      const index = path[path.length - 1];
      parent.children.splice(index, 1);
      result = { selectedPath: path.length === 1 ? '0' : formatPath(path.slice(0, -1)) };
      break;
    }
    case 'toggleFlag': {
      const node = getNodeByPath(parsed.root, path);
      const current = new Set(node.flags);
      if (current.has(message.flag)) {
        current.delete(message.flag);
      } else {
        current.add(message.flag);
      }
      node.flags = Array.from(current).sort((a, b) => a - b) as Flag[];
      result = { selectedPath: message.path };
      break;
    }
    case 'moveNode': {
      if (path.length === 0) {
        throw new Error('Root node cannot be reordered.');
      }
      const parent = getNodeByPath(parsed.root, path.slice(0, -1));
      const index = path[path.length - 1];
      const targetIndex =
        message.direction === 'up'
          ? (index - 1 + parent.children.length) % parent.children.length
          : (index + 1) % parent.children.length;
      if (targetIndex !== index) {
        const [node] = parent.children.splice(index, 1);
        parent.children.splice(targetIndex, 0, node);
      }
      const movedPath = [...path.slice(0, -1), targetIndex];
      result = { selectedPath: formatPath(movedPath) };
      break;
    }
  }

  await replaceDocument(document, serializeDocument(parsed.root));
  return result;
}

function parseFlags(input: string): Flag[] {
  if (input === '[]') {
    return [];
  }
  if (!/^\[(Done|Rejected|Question|Task|Idea|Low priority|Medium priority|High priority)(,(Done|Rejected|Question|Task|Idea|Low priority|Medium priority|High priority))*\]$/.test(input)) {
    throw new Error(`Invalid flags token "${input}"`);
  }

  const names = input.slice(1, -1).split(',');
  const flags = names.map((name) => {
    if (name === 'Done') {
      return 1;
    }
    if (name === 'Rejected') {
      return 2;
    }
    if (name === 'Question') {
      return 3;
    }
    if (name === 'Task') {
      return 4;
    }
    if (name === 'Idea') {
      return 5;
    }
    if (name === 'Low priority') {
      return 6;
    }
    if (name === 'Medium priority') {
      return 7;
    }
    if (name === 'High priority') {
      return 8;
    }
    throw new Error(`Unknown flag "${name}"`);
  }) as Flag[];

  if (new Set(flags).size !== flags.length) {
    throw new Error(`Duplicated flags token "${input}"`);
  }
  if (flags.some((flag, index) => index > 0 && flags[index - 1] > flag)) {
    throw new Error(`Flags must be ordered as [Done,Rejected,Question,Task,Idea,Low priority,Medium priority,High priority], got "${input}"`);
  }
  return flags;
}

function formatPath(path: number[]): string {
  return path.length === 0 ? '0' : `0.${path.join('.')}`;
}

function pathsEqual(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function comparePaths(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return left.length - right.length;
}

function isDescendantPath(candidate: number[], ancestor: number[]): boolean {
  return candidate.length > ancestor.length && ancestor.every((value, index) => candidate[index] === value);
}

function findPathToNode(root: MindMapNode, target: MindMapNode): number[] | undefined {
  if (root === target) {
    return [];
  }

  const visit = (node: MindMapNode, path: number[]): number[] | undefined => {
    for (let index = 0; index < node.children.length; index += 1) {
      const child = node.children[index];
      const childPath = [...path, index];
      if (child === target) {
        return childPath;
      }
      const nested = visit(child, childPath);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  };

  return visit(root, []);
}

function sanitizeName(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function formatFlag(flag: Flag): 'Done' | 'Rejected' | 'Question' | 'Task' | 'Idea' | 'Low priority' | 'Medium priority' | 'High priority' {
  if (flag === 1) {
    return 'Done';
  }
  if (flag === 2) {
    return 'Rejected';
  }
  if (flag === 3) {
    return 'Question';
  }
  if (flag === 4) {
    return 'Task';
  }
  if (flag === 5) {
    return 'Idea';
  }
  if (flag === 6) {
    return 'Low priority';
  }
  if (flag === 7) {
    return 'Medium priority';
  }
  return 'High priority';
}

async function replaceDocument(document: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  const start = new vscode.Position(0, 0);
  const end = document.lineCount === 0
    ? new vscode.Position(0, 0)
    : document.lineAt(document.lineCount - 1).rangeIncludingLineBreak.end;
  edit.replace(document.uri, new vscode.Range(start, end), text);
  await vscode.workspace.applyEdit(edit);
}
