    const vscode = acquireVsCodeApi();
    const app = document.getElementById('app');
    const canvas = document.getElementById('canvas');
    const nodesLayer = document.getElementById('nodes');
    const edgesLayer = document.getElementById('edges');
    const statusEl = document.getElementById('status');
    const zoomControlEl = document.getElementById('zoomControl');
    const zoomLabel = document.getElementById('zoomLabel');
    const hintEl = document.getElementById('hint');
    const hintBodyEl = document.getElementById('hintBody');
    const hintToggleEl = document.getElementById('hintToggle');
    const contextMenuEl = document.getElementById('contextMenu');

    const state = {
      tree: null,
      selectedPath: '0',
      selectedPaths: new Set(['0']),
      editingPath: null,
      editValue: '',
      panX: 80,
      panY: 80,
      zoom: 1,
      pendingSelection: null,
      pendingSelectedPaths: null,
      pendingEdit: null,
      pendingCreatedNodePath: null,
      hintCollapsed: true,
      layoutByPath: new Map(),
      measuredHeights: new Map(),
      flatNodes: [],
      drag: null,
      nodeDrag: null,
      draggedNodePath: null,
      draggedNodePaths: null,
      dropTargetPath: null,
      contextMenuPath: null,
      zoomMenuOpen: false,
    };

    let focusFrame = 0;
    let rerenderFrame = 0;

    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    const altLabel = isMac ? 'Option' : 'Alt';
    const zoomLevels = [0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

    const layoutConfig = {
      nodeWidth: 196,
      nodeHeight: 32,
      horizontalGap: 96,
      verticalGap: 12,
      padding: 140,
    };

    function post(message) {
      vscode.postMessage(message);
    }

    function escapeHtml(value) {
      return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function showError(message) {
      statusEl.style.display = message ? 'block' : 'none';
      statusEl.textContent = message || '';
    }

    function renderHint() {
      hintBodyEl.textContent =
        'Enter/F2 edit, Shift+Enter add child, ' +
        altLabel + '+Enter add sibling below, Shift+' + altLabel + '+Enter add sibling above, ' +
        'Space collapse, Delete remove, ' +
        'Ctrl+' + altLabel + '+1 done, ' +
        'Ctrl+' + altLabel + '+2 rejected, ' +
        'Ctrl+' + altLabel + '+3 question, ' +
        'Ctrl+' + altLabel + '+4 task, ' +
        'Ctrl+' + altLabel + '+5 idea, ' +
        'Ctrl+' + altLabel + '+6 low priority, ' +
        'Ctrl+' + altLabel + '+7 medium priority, ' +
        'Ctrl+' + altLabel + '+8 high priority, Ctrl+Up/Down reorder.';
      hintEl.classList.toggle('collapsed', state.hintCollapsed);
      hintToggleEl.textContent = state.hintCollapsed ? 'Show' : 'Hide';
    }

    function setTransform() {
      canvas.style.transform = 'translate(' + state.panX + 'px, ' + state.panY + 'px) scale(' + state.zoom + ')';
      zoomLabel.textContent = Math.round(state.zoom * 100) + '%';
      zoomControlEl.setAttribute('aria-expanded', state.zoomMenuOpen ? 'true' : 'false');
    }

    function collectVisible(node, parentPath, depth, list) {
      list.push({ node, path: node.path, depth, parentPath });
      if (!node.collapsed) {
        for (const child of node.children) {
          collectVisible(child, node.path, depth + 1, list);
        }
      }
    }

    function layoutTree(root, getHeight = getNodeHeight) {
      const layoutByPath = new Map();
      let cursorY = 0;

      function shiftSubtree(path, deltaY) {
        for (const [key, layout] of layoutByPath.entries()) {
          if (key === path || key.startsWith(path + '.')) {
            layoutByPath.set(key, { ...layout, y: layout.y + deltaY });
          }
        }
      }

      function visit(node, depth, parentPath) {
        const x = depth * (layoutConfig.nodeWidth + layoutConfig.horizontalGap);
        const height = getHeight(node.path, node);
        if (!node.children.length || node.collapsed) {
          const y = cursorY;
          cursorY += height + layoutConfig.verticalGap;
          layoutByPath.set(node.path, { x, y, height, parentPath, depth });
          return { top: y, bottom: y + height, center: y + height / 2 };
        }

        const startY = cursorY;
        let childTop = Number.POSITIVE_INFINITY;
        let childBottom = Number.NEGATIVE_INFINITY;
        const childCenters = [];
        for (const child of node.children) {
          const childLayout = visit(child, depth + 1, node.path);
          childTop = Math.min(childTop, childLayout.top);
          childBottom = Math.max(childBottom, childLayout.bottom);
          childCenters.push(childLayout.center);
        }
        let centerY = (childCenters[0] + childCenters[childCenters.length - 1]) / 2;
        let y = centerY - height / 2;

        if (y < startY) {
          const deltaY = startY - y;
          shiftSubtree(node.path, deltaY);
          childTop += deltaY;
          childBottom += deltaY;
          centerY += deltaY;
          y += deltaY;
        }

        layoutByPath.set(node.path, { x, y, height, parentPath, depth });
        const top = Math.min(y, childTop);
        const bottom = Math.max(y + height, childBottom);
        cursorY = bottom + layoutConfig.verticalGap;
        return { top, bottom, center: centerY };
      }

      visit(root, 0, null);
      return layoutByPath;
    }

    function cloneTreeExpanded(node) {
      return {
        path: node.path,
        name: node.name,
        collapsed: false,
        flags: [...node.flags],
        children: node.children.map((child) => cloneTreeExpanded(child)),
      };
    }

    function setSingleSelection(path) {
      state.selectedPath = path;
      state.selectedPaths = new Set([path]);
    }

    function toggleSelection(path) {
      const next = new Set(state.selectedPaths);
      if (next.has(path) && next.size > 1) {
        next.delete(path);
      } else {
        next.add(path);
        state.selectedPath = path;
      }
      state.selectedPaths = next;
    }

    function extendSelectionToPath(path) {
      if (!path || path === state.selectedPath) {
        return;
      }
      const next = new Set(state.selectedPaths);
      next.add(path);
      state.selectedPath = path;
      state.selectedPaths = next;
      state.editingPath = null;
      ensureSelectedVisible();
      render();
    }

    function normalizeSelection() {
      const paths = new Set(state.flatNodes.map((entry) => entry.path));
      if (state.pendingSelection && paths.has(state.pendingSelection)) {
        state.selectedPath = state.pendingSelection;
        state.pendingSelection = null;
      } else if (!paths.has(state.selectedPath)) {
        state.selectedPath = '0';
      }

      if (state.pendingSelectedPaths) {
        const selectedPaths = state.pendingSelectedPaths.filter((path) => paths.has(path));
        state.selectedPaths = new Set(selectedPaths.length > 0 ? selectedPaths : [state.selectedPath]);
        state.pendingSelectedPaths = null;
      } else {
        const selectedPaths = Array.from(state.selectedPaths).filter((path) => paths.has(path));
        state.selectedPaths = new Set(selectedPaths.length > 0 ? selectedPaths : [state.selectedPath]);
      }
      if (!state.selectedPaths.has(state.selectedPath)) {
        state.selectedPaths.add(state.selectedPath);
      }

      if (state.pendingEdit && paths.has(state.pendingEdit)) {
        state.editingPath = state.pendingEdit;
        const node = state.flatNodes.find((entry) => entry.path === state.pendingEdit);
        state.editValue = node ? node.node.name : '';
        state.pendingEdit = null;
      } else if (state.editingPath && !paths.has(state.editingPath)) {
        state.editingPath = null;
        state.editValue = '';
      }

      if (state.pendingCreatedNodePath && !paths.has(state.pendingCreatedNodePath)) {
        state.pendingCreatedNodePath = null;
      }
    }

    function render() {
      nodesLayer.innerHTML = '';
      edgesLayer.innerHTML = '';
      if (!state.tree) {
        return;
      }

      let layoutDirty = false;

      state.layoutByPath = layoutTree(state.tree);
      state.flatNodes = [];
      collectVisible(state.tree, null, 0, state.flatNodes);
      normalizeSelection();

      let maxX = 0;
      let maxY = 0;
      for (const entry of state.flatNodes) {
        const layout = state.layoutByPath.get(entry.path);
        maxX = Math.max(maxX, layout.x);
        maxY = Math.max(maxY, layout.y + layout.height);
      }

      edgesLayer.setAttribute('width', String(maxX + layoutConfig.nodeWidth + layoutConfig.padding));
      edgesLayer.setAttribute('height', String(maxY + layoutConfig.padding));
      canvas.style.width = maxX + layoutConfig.nodeWidth + layoutConfig.padding + 'px';
      canvas.style.height = maxY + layoutConfig.padding + 'px';

      for (const entry of state.flatNodes) {
        const layout = state.layoutByPath.get(entry.path);
        if (layout.parentPath) {
          const parentLayout = state.layoutByPath.get(layout.parentPath);
          const startX = parentLayout.x + layoutConfig.nodeWidth;
          const startY = parentLayout.y + parentLayout.height / 2;
          const endX = layout.x;
          const endY = layout.y + layout.height / 2;
          const midX = startX + (endX - startX) / 2;
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('class', 'edge');
          path.setAttribute('d', 'M ' + startX + ' ' + startY + ' C ' + midX + ' ' + startY + ', ' + midX + ' ' + endY + ', ' + endX + ' ' + endY);
          edgesLayer.appendChild(path);
        }

        const nodeEl = document.createElement('div');
        const selected = state.selectedPaths.has(entry.path);
        const editing = entry.path === state.editingPath;
        nodeEl.className = 'node' + (selected ? ' selected' : '') + (editing ? ' editing' : '') + (entry.path === '0' ? ' node-root' : '');
        if (state.draggedNodePaths && state.draggedNodePaths.includes(entry.path)) {
          nodeEl.className += ' dragging-node';
        }
        if (entry.path === state.dropTargetPath) {
          nodeEl.className += ' drop-target';
        }
        nodeEl.style.left = layout.x + 'px';
        nodeEl.style.top = layout.y + 'px';
        nodeEl.dataset.path = entry.path;

        const hasChildren = entry.node.children.length > 0;
        const collapseIndicator = hasChildren ? (entry.node.collapsed ? '+' : '−') : '';
        const doneBadge = entry.node.flags.includes(1) ? '<span class="badge flag-done">✓ Done</span>' : '';
        const rejectedBadge = entry.node.flags.includes(2) ? '<span class="badge flag-rejected">✕ Rejected</span>' : '';
        const questionBadge = entry.node.flags.includes(3) ? '<span class="badge flag-question">? Question</span>' : '';
        const taskBadge = entry.node.flags.includes(4) ? '<span class="badge flag-task">☰ Task</span>' : '';
        const ideaBadge = entry.node.flags.includes(5) ? '<span class="badge flag-idea">💡 Idea</span>' : '';
        const lowPriorityBadge = entry.node.flags.includes(6) ? '<span class="badge flag-priority-low">Low priority</span>' : '';
        const mediumPriorityBadge = entry.node.flags.includes(7) ? '<span class="badge flag-priority-medium">Medium priority</span>' : '';
        const highPriorityBadge = entry.node.flags.includes(8) ? '<span class="badge flag-priority-high">High priority</span>' : '';
        const flagsMarkup = doneBadge + rejectedBadge + questionBadge + taskBadge + ideaBadge + lowPriorityBadge + mediumPriorityBadge + highPriorityBadge;
        const metaMarkup = flagsMarkup ? '<div class="meta has-flags">' + flagsMarkup + '</div>' : '';

        nodeEl.innerHTML =
          '<div class="node-header">' +
            '<span class="collapse">' + collapseIndicator + '</span>' +
            (editing
              ? '<textarea class="editor" spellcheck="false" rows="1">' + escapeHtml(state.editValue) + '</textarea>'
              : '<div class="name">' + escapeHtml(entry.node.name || ' ') + '</div>') +
          '</div>' +
          metaMarkup;

        nodeEl.addEventListener('mousedown', (event) => {
          event.stopPropagation();
          if (editing || entry.path === '0' || event.button !== 0) {
            return;
          }
          if (!state.selectedPaths.has(entry.path) && !event.ctrlKey && !event.metaKey) {
            setSingleSelection(entry.path);
          }
          state.nodeDrag = {
            path: entry.path,
            startX: event.clientX,
            startY: event.clientY,
            selectedPaths: Array.from(state.selectedPaths),
          };
        });
        nodeEl.addEventListener('click', (event) => {
          event.stopPropagation();
          if (state.draggedNodePath) {
            return;
          }
          closeContextMenu();
          if (event.ctrlKey || event.metaKey) {
            toggleSelection(entry.path);
          } else {
            setSingleSelection(entry.path);
          }
          render();
        });
        nodeEl.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!state.selectedPaths.has(entry.path)) {
            setSingleSelection(entry.path);
          } else {
            state.selectedPath = entry.path;
          }
          state.editingPath = null;
          render();
          openContextMenu(entry.path, event.clientX, event.clientY);
        });
        nodesLayer.appendChild(nodeEl);

        if (!editing) {
          layoutDirty = updateMeasuredHeight(entry.path, nodeEl, layout.height) || layoutDirty;
        }

        if (editing) {
          const input = nodeEl.querySelector('textarea');
          scheduleEditorFocus(input);
          autoSizeEditor(input);
          if (updateMeasuredHeight(entry.path, nodeEl, layout.height)) {
            scheduleRerender();
          }
          const setEditorValue = (nextValue) => {
            input.value = nextValue;
            state.editValue = nextValue;
            autoSizeEditor(input);
            if (updateMeasuredHeight(entry.path, nodeEl, layout.height)) {
              scheduleRerender();
            }
          };
          const replaceSelection = (replacement) => {
            const start = input.selectionStart ?? 0;
            const end = input.selectionEnd ?? 0;
            const nextValue = input.value.slice(0, start) + replacement + input.value.slice(end);
            setEditorValue(nextValue);
            const nextCursor = start + replacement.length;
            input.setSelectionRange(nextCursor, nextCursor);
          };
          input.addEventListener('input', () => {
            autoSizeEditor(input);
            if (updateMeasuredHeight(entry.path, nodeEl, layout.height)) {
              scheduleRerender();
            }
            state.editValue = input.value;
          });
          input.addEventListener('keydown', (event) => {
            event.stopPropagation();
            if (event.metaKey || event.ctrlKey) {
              const key = event.key.toLowerCase();
              if (key === 'a') {
                event.preventDefault();
                input.setSelectionRange(0, input.value.length);
                return;
              }
              if (key === 'c') {
                event.preventDefault();
                const start = input.selectionStart ?? 0;
                const end = input.selectionEnd ?? input.value.length;
                void navigator.clipboard.writeText(input.value.slice(start, end));
                return;
              }
              if (key === 'x') {
                event.preventDefault();
                const start = input.selectionStart ?? 0;
                const end = input.selectionEnd ?? input.value.length;
                void navigator.clipboard.writeText(input.value.slice(start, end));
                setEditorValue(input.value.slice(0, start) + input.value.slice(end));
                input.setSelectionRange(start, start);
                return;
              }
              if (key === 'v') {
                event.preventDefault();
                void navigator.clipboard.readText().then((text) => {
                  replaceSelection(text);
                });
                return;
              }
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              commitEdit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              cancelEdit();
            }
          });
        }
      }

      setTransform();
      if (layoutDirty) {
        scheduleRerender();
      }
    }

    function scheduleEditorFocus(input) {
      if (focusFrame) {
        cancelAnimationFrame(focusFrame);
      }
      focusFrame = requestAnimationFrame(() => {
        input.focus();
        autoSizeEditor(input);
        input.setSelectionRange(input.value.length, input.value.length);
        focusFrame = 0;
      });
    }

    function scheduleRerender() {
      if (rerenderFrame) {
        return;
      }
      rerenderFrame = requestAnimationFrame(() => {
        rerenderFrame = 0;
        render();
      });
    }

    function autoSizeEditor(input) {
      input.style.height = '0px';
      input.style.height = input.scrollHeight + 'px';
    }

    function updateMeasuredHeight(path, nodeEl, fallbackHeight) {
      const zoom = state.zoom || 1;
      if (state.editingPath === path) {
        const liveHeight = Math.ceil(nodeEl.getBoundingClientRect().height / zoom);
        nodeEl.style.minHeight = Math.max(fallbackHeight, liveHeight) + 'px';
        if (state.measuredHeights.get(path) !== liveHeight) {
          state.measuredHeights.set(path, liveHeight);
          return true;
        }
        return false;
      }
      const naturalHeight = Math.ceil(nodeEl.getBoundingClientRect().height / zoom);
      nodeEl.style.minHeight = Math.max(fallbackHeight, naturalHeight) + 'px';
      if (state.measuredHeights.get(path) !== naturalHeight) {
        state.measuredHeights.set(path, naturalHeight);
        return true;
      }
      return false;
    }

    function closeContextMenu() {
      state.contextMenuPath = null;
      contextMenuEl.classList.remove('open');
      contextMenuEl.classList.remove('zoom-menu');
      contextMenuEl.dataset.mode = '';
      contextMenuEl.innerHTML = '';
    }

    function appendContextMenuSection(items) {
      const section = document.createElement('div');
      section.className = 'context-menu-section';
      for (const item of items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'context-menu-item';
        button.disabled = Boolean(item.disabled);
        button.setAttribute('role', 'menuitem');

        if (item.icon) {
          const icon = document.createElement('span');
          icon.className = 'context-menu-icon';
          icon.textContent = item.icon;
          button.appendChild(icon);
        }

        const label = document.createElement('span');
        label.className = 'context-menu-label' + (item.className ? ' ' + item.className : '');
        label.textContent = item.label;
        button.appendChild(label);

        const check = document.createElement('span');
        check.className = 'context-menu-check';
        check.textContent = item.checked ? '✓' : '';
        button.appendChild(check);

        button.addEventListener('click', (event) => {
          event.stopPropagation();
          if (item.disabled) {
            return;
          }
          closeContextMenu();
          item.run();
        });
        section.appendChild(button);
      }
      contextMenuEl.appendChild(section);
    }

    function openContextMenu(path, clientX, clientY) {
      closeZoomMenu();
      const entry = state.flatNodes.find((candidate) => candidate.path === path);
      if (!entry) {
        return;
      }

      const isRoot = path === '0';
      const hasChildren = entry.node.children.length > 0;
      state.contextMenuPath = path;
      contextMenuEl.innerHTML = '';

      appendContextMenuSection([
        { label: 'Edit', icon: '✎', run: () => startEdit(path) },
        { label: 'Copy text', icon: '📋', run: () => post({ type: 'copyNodeText', path }) },
        { label: 'Paste text', icon: '📋', run: () => post({ type: 'pasteNodeText', path }) },
        { label: 'Undo', icon: '↶', run: () => post({ type: 'undo' }) },
        { label: 'Redo', icon: '↷', run: () => post({ type: 'redo' }) },
      ]);

      appendContextMenuSection([
        { label: 'Add child', icon: '➕', run: () => post({ type: 'addChild', path }) },
        { label: 'Add sibling above', icon: '➕', disabled: isRoot, run: () => post({ type: 'addSibling', path, position: 'before' }) },
        { label: 'Add sibling below', icon: '➕', disabled: isRoot, run: () => post({ type: 'addSibling', path, position: 'after' }) },
      ]);

      appendContextMenuSection([
        { label: entry.node.collapsed ? 'Expand' : 'Collapse', icon: entry.node.collapsed ? '⌄' : '⌃', disabled: !hasChildren, run: () => post({ type: 'toggleCollapse', path }) },
        { label: 'Move up', icon: '⬆', disabled: isRoot, run: () => post({ type: 'moveNode', path, direction: 'up' }) },
        { label: 'Move down', icon: '⬇', disabled: isRoot, run: () => post({ type: 'moveNode', path, direction: 'down' }) },
        { label: 'Delete', icon: '🗑', disabled: isRoot, run: () => post({ type: 'deleteNode', path }) },
      ]);

      appendContextMenuSection([
        { label: '✓ Done', className: 'flag-done', checked: entry.node.flags.includes(1), run: () => post({ type: 'toggleFlag', path, flag: 1 }) },
        { label: '✕ Rejected', className: 'flag-rejected', checked: entry.node.flags.includes(2), run: () => post({ type: 'toggleFlag', path, flag: 2 }) },
        { label: '? Question', className: 'flag-question', checked: entry.node.flags.includes(3), run: () => post({ type: 'toggleFlag', path, flag: 3 }) },
        { label: '☰ Task', className: 'flag-task', checked: entry.node.flags.includes(4), run: () => post({ type: 'toggleFlag', path, flag: 4 }) },
        { label: '💡 Idea', className: 'flag-idea', checked: entry.node.flags.includes(5), run: () => post({ type: 'toggleFlag', path, flag: 5 }) },
        { label: 'Low priority', className: 'flag-priority-low', checked: entry.node.flags.includes(6), run: () => post({ type: 'toggleFlag', path, flag: 6 }) },
        { label: 'Medium priority', className: 'flag-priority-medium', checked: entry.node.flags.includes(7), run: () => post({ type: 'toggleFlag', path, flag: 7 }) },
        { label: 'High priority', className: 'flag-priority-high', checked: entry.node.flags.includes(8), run: () => post({ type: 'toggleFlag', path, flag: 8 }) },
      ]);

      contextMenuEl.classList.add('open');
      contextMenuEl.style.left = '0px';
      contextMenuEl.style.top = '0px';
      const menuRect = contextMenuEl.getBoundingClientRect();
      const left = Math.min(clientX, window.innerWidth - menuRect.width - 8);
      const top = Math.min(clientY, window.innerHeight - menuRect.height - 8);
      contextMenuEl.style.left = Math.max(8, left) + 'px';
      contextMenuEl.style.top = Math.max(8, top) + 'px';
    }

    function closeZoomMenu() {
      state.zoomMenuOpen = false;
      zoomControlEl.setAttribute('aria-expanded', 'false');
      contextMenuEl.classList.remove('open');
      contextMenuEl.classList.remove('zoom-menu');
      if (contextMenuEl.dataset.mode === 'zoom') {
        contextMenuEl.innerHTML = '';
      }
      contextMenuEl.dataset.mode = '';
    }

    function appendMenuSection(container, items) {
      const section = document.createElement('div');
      section.className = 'context-menu-section';
      for (const item of items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'context-menu-item';
        button.disabled = Boolean(item.disabled);
        button.setAttribute('role', 'menuitem');

        if (item.icon) {
          const icon = document.createElement('span');
          icon.className = 'context-menu-icon';
          icon.textContent = item.icon;
          button.appendChild(icon);
        }

        const label = document.createElement('span');
        label.className = 'context-menu-label' + (item.className ? ' ' + item.className : '');
        label.textContent = item.label;
        button.appendChild(label);

        const check = document.createElement('span');
        check.className = 'context-menu-check';
        check.textContent = item.checked ? '✓' : '';
        button.appendChild(check);

        button.addEventListener('click', (event) => {
          event.stopPropagation();
          if (item.disabled) {
            return;
          }
          if (item.closeOnClick !== false) {
            closeZoomMenu();
          }
          item.run();
        });
        section.appendChild(button);
      }
      container.appendChild(section);
    }

    function openZoomMenu() {
      state.zoomMenuOpen = true;
      contextMenuEl.dataset.mode = 'zoom';
      contextMenuEl.innerHTML = '';

      appendMenuSection(contextMenuEl, [
        { label: 'Zoom in', icon: '＋', run: () => zoomAt(state.zoom * 1.15, window.innerWidth / 2, window.innerHeight / 2) },
        { label: 'Zoom out', icon: '－', run: () => zoomAt(state.zoom / 1.15, window.innerWidth / 2, window.innerHeight / 2) },
      ]);

      appendMenuSection(contextMenuEl, zoomLevels.map((zoomLevel) => ({
        label: Math.round(zoomLevel * 100) + '%',
        checked: Math.abs(state.zoom - zoomLevel) < 0.001,
        run: () => zoomAt(zoomLevel, window.innerWidth / 2, window.innerHeight / 2),
      })));

      contextMenuEl.classList.add('open', 'zoom-menu');
      contextMenuEl.style.left = '0px';
      contextMenuEl.style.top = '0px';
      const anchorRect = zoomControlEl.getBoundingClientRect();
      const menuRect = contextMenuEl.getBoundingClientRect();
      const left = Math.min(anchorRect.right - menuRect.width, window.innerWidth - menuRect.width - 8);
      const top = Math.min(anchorRect.top - menuRect.height - 8, window.innerHeight - menuRect.height - 8);
      contextMenuEl.style.left = Math.max(8, left) + 'px';
      contextMenuEl.style.top = Math.max(8, top) + 'px';
      zoomControlEl.setAttribute('aria-expanded', 'true');
    }

    function toggleZoomMenu() {
      if (state.zoomMenuOpen) {
        closeZoomMenu();
      } else {
        closeContextMenu();
        openZoomMenu();
      }
    }

    function currentIndex() {
      return state.flatNodes.findIndex((entry) => entry.path === state.selectedPath);
    }

    function selectedEntry() {
      return state.flatNodes.find((entry) => entry.path === state.selectedPath) || null;
    }

    function ensureSelectedVisible() {
      const layout = state.layoutByPath.get(state.selectedPath);
      if (!layout) {
        return;
      }
      const scaledX = layout.x * state.zoom + state.panX;
      const scaledY = layout.y * state.zoom + state.panY;
      const width = layoutConfig.nodeWidth * state.zoom;
      const height = layout.height * state.zoom;
      const margin = 40;
      if (scaledX < margin) {
        state.panX += margin - scaledX;
      } else if (scaledX + width > window.innerWidth - margin) {
        state.panX -= scaledX + width - (window.innerWidth - margin);
      }
      if (scaledY < margin) {
        state.panY += margin - scaledY;
      } else if (scaledY + height > window.innerHeight - margin) {
        state.panY -= scaledY + height - (window.innerHeight - margin);
      }
      setTransform();
    }

    function moveSelectionVertical(direction) {
      const entry = selectedEntry();
      if (!entry) {
        return;
      }

      const segments = entry.path.split('.');
      if (segments.length === 1) {
        if (entry.node.children.length > 0) {
          const childIndex = direction > 0 ? 0 : entry.node.children.length - 1;
          setSingleSelection(entry.node.children[childIndex].path);
        }
        state.editingPath = null;
        ensureSelectedVisible();
        render();
        return;
      }

      const selfIndex = Number(segments[segments.length - 1]);
      const parentPath = segments.slice(0, -1).join('.');
      const parentEntry = state.flatNodes.find((candidate) => candidate.path === parentPath);
      if (!parentEntry || parentEntry.node.children.length === 0) {
        return;
      }

      const siblingCount = parentEntry.node.children.length;
      const nextIndex = (selfIndex + direction + siblingCount) % siblingCount;
      setSingleSelection(parentEntry.node.children[nextIndex].path);
      state.editingPath = null;
      ensureSelectedVisible();
      render();
    }

    function navigateHorizontal(direction) {
      const entry = selectedEntry();
      if (!entry) {
        return;
      }
      if (direction > 0) {
        if (!entry.node.collapsed && entry.node.children.length > 0) {
          setSingleSelection(entry.node.children[0].path);
        }
      } else {
        const segments = entry.path.split('.');
        if (segments.length > 1) {
          segments.pop();
          setSingleSelection(segments.join('.'));
        }
      }
      ensureSelectedVisible();
      render();
    }

    function startEdit(path) {
      const entry = state.flatNodes.find((candidate) => candidate.path === path);
      if (!entry) {
        return;
      }
      setSingleSelection(path);
      state.editingPath = path;
      state.editValue = entry.node.name;
      state.pendingCreatedNodePath = null;
      state.measuredHeights.delete(path);
      render();
    }

    function commitEdit() {
      if (!state.editingPath) {
        return;
      }
      const path = state.editingPath;
      const value = state.editValue;
      state.editingPath = null;
      state.pendingCreatedNodePath = null;
      state.pendingSelection = path;
      state.measuredHeights.delete(path);
      post({ type: 'setName', path, name: value });
    }

    function copySelectedNodeText() {
      const entry = selectedEntry();
      if (!entry) {
        return;
      }
      post({ type: 'copyNodeText', path: entry.path });
    }

    function pasteIntoSelectedNodeText() {
      const entry = selectedEntry();
      if (!entry) {
        return;
      }
      post({ type: 'pasteNodeText', path: entry.path });
    }

    function cancelEdit() {
      const path = state.editingPath;
      const shouldDeleteCreatedNode = path && state.pendingCreatedNodePath === path;
      state.editingPath = null;
      state.editValue = '';
      state.pendingCreatedNodePath = null;
      if (path) {
        state.measuredHeights.delete(path);
      }
      render();
      if (shouldDeleteCreatedNode) {
        post({ type: 'deleteNode', path });
      }
    }

    function zoomAt(nextZoom, clientX, clientY) {
      const bounded = Math.min(2.2, Math.max(0.35, nextZoom));
      const worldX = (clientX - state.panX) / state.zoom;
      const worldY = (clientY - state.panY) / state.zoom;
      state.zoom = bounded;
      state.panX = clientX - worldX * state.zoom;
      state.panY = clientY - worldY * state.zoom;
      setTransform();
      post({ type: 'zoomChanged', zoom: state.zoom });
    }

    function canDropNodes(sourcePaths, targetPath) {
      if (!sourcePaths || sourcePaths.length === 0 || !targetPath) {
        return false;
      }
      for (const sourcePath of sourcePaths) {
        if (sourcePath === '0' || sourcePath === targetPath || targetPath.startsWith(sourcePath + '.')) {
          return false;
        }
      }
      return true;
    }

    function findDropTargetPath(clientX, clientY) {
      const element = document.elementFromPoint(clientX, clientY);
      const node = element ? element.closest('.node') : null;
      const targetPath = node ? node.dataset.path || null : null;
      return canDropNodes(state.draggedNodePaths, targetPath) ? targetPath : null;
    }

    function getNodeHeight(path, node) {
      const measuredHeight = state.measuredHeights.get(path);
      if (measuredHeight) {
        return measuredHeight;
      }
      const charsPerLine = 22;
      const lines = Math.max(1, Math.ceil((node.name || ' ').length / charsPerLine));
      const nameHeight = lines * 16;
      const flagCount = node.flags.length;
      const flagRows = flagCount > 0 ? Math.ceil(flagCount / 2) : 0;
      const flagsHeight = flagRows > 0 ? flagRows * 14 + 3 : 0;
      return Math.max(layoutConfig.nodeHeight, 14 + nameHeight + flagsHeight);
    }

    function getExportNodeHeight(ctx, path, node) {
      const textXOffset = 34;
      const textMaxWidth = layoutConfig.nodeWidth - textXOffset - 12;
      const textLines = wrapText(ctx, node.name || ' ', textMaxWidth);
      const badges = getFlagBadgeDefinitions(node.flags);
      const badgeFont = '10px ' + getComputedStyle(document.body).fontFamily;
      ctx.save();
      ctx.font = badgeFont;
      const badgeRows = countBadgeRows(ctx, badges, textMaxWidth);
      ctx.restore();
      const flagsHeight = badgeRows > 0 ? 3 + (badgeRows * 14) + ((badgeRows - 1) * 3) : 0;
      return Math.max(layoutConfig.nodeHeight, 8 + Math.max(18, textLines.length * 18) + flagsHeight + 8);
    }

    function readCssVar(name) {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }

    function getExportColors() {
      return {
        bg: readCssVar('--bg') || '#ffffff',
        bgSoft: readCssVar('--bg-soft') || '#f6f7f8',
        fg: readCssVar('--fg') || '#111111',
        muted: readCssVar('--muted') || '#666666',
        nodeFillStart: readCssVar('--node-fill-start') || '#e8ebee',
        nodeFillEnd: readCssVar('--node-fill-end') || '#dde1e5',
        nodeSelectedFillStart: readCssVar('--node-selected-fill-start') || '#dadfe2',
        nodeSelectedFillEnd: readCssVar('--node-selected-fill-end') || '#cdd2d7',
        nodeBorder: readCssVar('--node-border') || '#bec2c6',
        nodeSelectedBorder: readCssVar('--node-selected-border') || '#50585f',
        nodeRootFillStart: readCssVar('--node-root-fill-start') || 'rgba(55, 189, 203, 0.18)',
        nodeRootFillEnd: readCssVar('--node-root-fill-end') || 'rgba(255, 255, 255, 0.88)',
        nodeRootSelectedFillStart: readCssVar('--node-root-selected-fill-start') || 'rgba(30, 156, 170, 0.22)',
        nodeRootSelectedFillEnd: readCssVar('--node-root-selected-fill-end') || 'rgba(233, 248, 250, 0.94)',
        nodeRootSelectedBorder: readCssVar('--node-root-selected-border') || '#1f848f',
        done: readCssVar('--done') || '#2ea043',
        rejected: readCssVar('--rejected') || '#cf222e',
        question: readCssVar('--question') || '#1f6feb',
        task: readCssVar('--task') || '#7c3aed',
        idea: readCssVar('--idea') || '#d29922',
        priorityLow: readCssVar('--priority-low') || '#8b949e',
        priorityMedium: readCssVar('--priority-medium') || '#d29922',
        priorityHigh: readCssVar('--priority-high') || '#fb8500',
        shadow: 'rgba(13, 33, 44, 0.06)',
      };
    }

    function waitForFonts() {
      if (document.fonts && document.fonts.ready) {
        return document.fonts.ready.catch(() => undefined);
      }
      return Promise.resolve();
    }

    function wrapText(ctx, text, maxWidth) {
      const source = text || ' ';
      const words = source.split(/\s+/).filter(Boolean);
      if (words.length === 0) {
        return [' '];
      }

      const lines = [];
      let current = '';

      function pushCurrent() {
        if (current) {
          lines.push(current);
          current = '';
        }
      }

      function splitLongWord(word) {
        let chunk = '';
        for (const char of word) {
          if (ctx.measureText(chunk + char).width <= maxWidth || chunk.length === 0) {
            chunk += char;
          } else {
            lines.push(chunk);
            chunk = char;
          }
        }
        if (chunk) {
          current = chunk;
        }
      }

      for (const word of words) {
        const candidate = current ? current + ' ' + word : word;
        if (ctx.measureText(candidate).width <= maxWidth) {
          current = candidate;
          continue;
        }
        pushCurrent();
        if (ctx.measureText(word).width <= maxWidth) {
          current = word;
        } else {
          splitLongWord(word);
        }
      }

      pushCurrent();
      return lines.length > 0 ? lines : [source];
    }

    function getFlagBadgeDefinitions(flags) {
      return [
        flags.includes(1) ? { label: '✓ Done', color: getExportColors().done } : null,
        flags.includes(2) ? { label: '✕ Rejected', color: getExportColors().rejected } : null,
        flags.includes(3) ? { label: '? Question', color: getExportColors().question } : null,
        flags.includes(4) ? { label: '☰ Task', color: getExportColors().task } : null,
        flags.includes(5) ? { label: '💡 Idea', color: getExportColors().idea } : null,
        flags.includes(6) ? { label: 'Low priority', color: getExportColors().priorityLow } : null,
        flags.includes(7) ? { label: 'Medium priority', color: getExportColors().priorityMedium } : null,
        flags.includes(8) ? { label: 'High priority', color: getExportColors().priorityHigh } : null,
      ].filter(Boolean);
    }

    function countBadgeRows(ctx, badges, availableWidth) {
      let rows = 0;
      let currentWidth = 0;
      const gap = 6;
      for (const badge of badges) {
        const badgeWidth = ctx.measureText(badge.label).width + 14;
        if (currentWidth > 0 && currentWidth + badgeWidth > availableWidth) {
          rows += 1;
          currentWidth = 0;
        }
        if (currentWidth === 0) {
          currentWidth = badgeWidth;
        } else {
          currentWidth += gap + badgeWidth;
        }
      }
      if (currentWidth > 0) {
        rows += 1;
      }
      return rows;
    }

    function measureExportNode(ctx, node, hasChildren) {
      const nodePaddingX = 12;
      const collapseSize = 20;
      const gap = 6;
      const textXOffset = nodePaddingX + collapseSize + gap;
      const textMaxWidth = layoutConfig.nodeWidth - textXOffset - nodePaddingX;
      const textLines = wrapText(ctx, node.name || ' ', textMaxWidth);
      const badges = getFlagBadgeDefinitions(node.flags);
      const badgeFont = '10px ' + getComputedStyle(document.body).fontFamily;
      ctx.save();
      ctx.font = badgeFont;
      const badgeRows = countBadgeRows(ctx, badges, textMaxWidth);
      ctx.restore();
      const headerHeight = Math.max(collapseSize, textLines.length * 19);
      return {
        textLines,
        badgeRows,
        height: Math.max(layoutConfig.nodeHeight, 10 + headerHeight + (badgeRows > 0 ? 4 + (badgeRows * 16) + ((badgeRows - 1) * 4) : 0) + 10),
      };
    }

    function renderExportNode(ctx, node, layout, colors, offsetX, offsetY) {
      const x = layout.x + offsetX;
      const y = layout.y + offsetY;
      const width = layoutConfig.nodeWidth;
      const height = layout.height;
      const rootNode = node.path === '0';
      const collapsed = node.collapsed;
      const hasChildren = node.children.length > 0;
      const selected = node.path === state.selectedPath;
      const nodePaddingX = 10;
      const nodePaddingY = 8;
      const collapseSize = 18;
      const collapseRadius = 5;
      const headerGap = 4;

      ctx.save();
      ctx.shadowColor = rootNode ? 'rgba(13, 33, 44, 0.04)' : colors.shadow;
      ctx.shadowBlur = rootNode ? 6 : 8;
      ctx.shadowOffsetY = rootNode ? 1 : 2;
      const fillGradient = ctx.createLinearGradient(x, y, x, y + height);
      if (rootNode && selected) {
        fillGradient.addColorStop(0, 'rgba(205, 233, 236, 1)');
        fillGradient.addColorStop(1, 'rgba(234, 248, 250, 1)');
        ctx.strokeStyle = 'rgba(55, 189, 203, 0.96)';
      } else if (rootNode) {
        fillGradient.addColorStop(0, 'rgba(205, 233, 236, 1)');
        fillGradient.addColorStop(1, 'rgba(246, 251, 252, 1)');
        ctx.strokeStyle = colors.nodeBorder;
      } else if (selected) {
        fillGradient.addColorStop(0, colors.nodeSelectedFillStart);
        fillGradient.addColorStop(1, colors.nodeSelectedFillEnd);
        ctx.strokeStyle = colors.nodeSelectedBorder;
      } else {
        fillGradient.addColorStop(0, colors.nodeFillStart);
        fillGradient.addColorStop(1, colors.nodeFillEnd);
        ctx.strokeStyle = colors.nodeBorder;
      }
      ctx.fillStyle = fillGradient;
      ctx.lineWidth = 1;
      roundRect(ctx, x, y, width, height, 12);
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.stroke();

      ctx.fillStyle = colors.fg;
      ctx.font = '13px ' + getComputedStyle(document.body).fontFamily;
      ctx.textBaseline = 'top';

      let textX = x + nodePaddingX + collapseSize + headerGap;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.strokeStyle = 'rgba(13, 29, 39, 0.12)';
      ctx.lineWidth = 1;
      roundRect(ctx, x + nodePaddingX, y + nodePaddingY, collapseSize, collapseSize, collapseRadius);
      ctx.fill();
      ctx.stroke();
      if (hasChildren) {
        ctx.fillStyle = colors.muted;
        ctx.font = '700 13px ' + getComputedStyle(document.body).fontFamily;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(collapsed ? '+' : '−', x + nodePaddingX + collapseSize / 2, y + nodePaddingY + collapseSize / 2 + 0.5);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
      }

      const textMetrics = measureExportNode(ctx, node, hasChildren);
      ctx.fillStyle = colors.fg;
      ctx.font = '13px ' + getComputedStyle(document.body).fontFamily;
      const lineHeight = 18;
      const textTop = y + nodePaddingY + 3;
      const textWidth = width - (textX - x) - 12;
      const textLines = wrapText(ctx, node.name || ' ', textWidth);
      for (let index = 0; index < textLines.length; index += 1) {
        ctx.fillText(textLines[index], textX, textTop + index * lineHeight);
      }

      const badges = getFlagBadgeDefinitions(node.flags);
      if (badges.length > 0) {
        const badgeTop = textTop + textLines.length * lineHeight + 3;
        const badgeFont = '10px ' + getComputedStyle(document.body).fontFamily;
        ctx.font = badgeFont;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        let badgeX = textX;
        let badgeY = badgeTop;
        const badgeGapX = 5;
        const badgeGapY = 3;
        const maxBadgeWidth = width - (textX - x) - 12;
        let rowWidth = 0;
        const rowHeight = 14;
        for (let index = 0; index < badges.length; index += 1) {
          const badge = badges[index];
          const badgeWidth = ctx.measureText(badge.label).width + 14;
          if (badgeX !== textX && rowWidth + badgeWidth > maxBadgeWidth) {
            badgeX = textX;
            badgeY += rowHeight + badgeGapY;
            rowWidth = 0;
          }

          ctx.fillStyle = withAlpha(colors.bg, 1);
          ctx.strokeStyle = withAlpha(colors.fg, 0.08);
          ctx.lineWidth = 1;
          roundRect(ctx, badgeX, badgeY, badgeWidth, rowHeight, 999);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = badge.color;
          ctx.fillText(badge.label, badgeX + 6, badgeY + 7);
          rowWidth = rowWidth === 0 ? badgeWidth : rowWidth + badgeGapX + badgeWidth;
          badgeX += badgeWidth + badgeGapX;
        }
      }

      ctx.restore();
      return textMetrics;
    }

    function roundRect(ctx, x, y, width, height, radius) {
      const r = Math.min(radius, width / 2, height / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + width, y, x + width, y + height, r);
      ctx.arcTo(x + width, y + height, x, y + height, r);
      ctx.arcTo(x, y + height, x, y, r);
      ctx.arcTo(x, y, x + width, y, r);
      ctx.closePath();
    }

    function mixColor(base, overlay, alpha) {
      const normalizedAlpha = Math.max(0, Math.min(1, alpha));
      return overlay.replace(/rgb\(([^)]+)\)/, 'rgba($1, ' + normalizedAlpha + ')').replace(/#([0-9a-fA-F]{6})/, (match) => {
        const bigint = parseInt(match.slice(1), 16);
        const r = (bigint >> 16) & 255;
        const g = (bigint >> 8) & 255;
        const b = bigint & 255;
        return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + normalizedAlpha + ')';
      }) || base;
    }

    function withAlpha(color, alpha) {
      const normalizedAlpha = Math.max(0, Math.min(1, alpha));
      const rgbMatch = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color);
      if (rgbMatch) {
        return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${normalizedAlpha})`;
      }
      const rgbaMatch = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([^)]+)\)$/.exec(color);
      if (rgbaMatch) {
        return `rgba(${rgbaMatch[1]}, ${rgbaMatch[2]}, ${rgbaMatch[3]}, ${normalizedAlpha})`;
      }
      const hexMatch = /^#([0-9a-fA-F]{6})$/.exec(color);
      if (hexMatch) {
        const bigint = parseInt(hexMatch[1], 16);
        const r = (bigint >> 16) & 255;
        const g = (bigint >> 8) & 255;
        const b = bigint & 255;
        return `rgba(${r}, ${g}, ${b}, ${normalizedAlpha})`;
      }
      return color;
    }

    async function exportAsCanvasPng(sourceTree, expandMode) {
      const colors = getExportColors();
      const exportCanvas = document.createElement('canvas');
      const exportCtx = exportCanvas.getContext('2d');
      if (!exportCtx) {
        throw new Error('Canvas export is not supported in this environment.');
      }
      const fontFamily = getComputedStyle(document.body).fontFamily;
      exportCtx.font = '12px ' + fontFamily;
      const layoutByPath = layoutTree(
        sourceTree,
        expandMode === 'expanded'
          ? (path, node) => getExportNodeHeight(exportCtx, path, node)
          : getNodeHeight,
      );
      const flatNodes = [];
      collectVisible(sourceTree, null, 0, flatNodes);

      let maxX = 0;
      let maxY = 0;
      for (const entry of flatNodes) {
        const layout = layoutByPath.get(entry.path);
        maxX = Math.max(maxX, layout.x);
        maxY = Math.max(maxY, layout.y + layout.height);
      }

      const exportPadding = 24;
      const width = Math.ceil(maxX + layoutConfig.nodeWidth + exportPadding * 2);
      const height = Math.ceil(maxY + exportPadding * 2);
      const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(width * scale);
      canvas.height = Math.ceil(height * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Canvas export is not supported in this environment.');
      }
      ctx.scale(scale, scale);

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);

      ctx.strokeStyle = 'rgba(121, 131, 142, 0.50)';
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const entry of flatNodes) {
        const layout = layoutByPath.get(entry.path);
        if (!layout.parentPath) {
          continue;
        }
        const parentLayout = layoutByPath.get(layout.parentPath);
        const startX = parentLayout.x + layoutConfig.nodeWidth + exportPadding;
        const startY = parentLayout.y + parentLayout.height / 2 + exportPadding;
        const endX = layout.x + exportPadding;
        const endY = layout.y + layout.height / 2 + exportPadding;
        const midX = startX + (endX - startX) / 2;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.bezierCurveTo(midX, startY, midX, endY, endX, endY);
        ctx.stroke();
      }

      for (const entry of flatNodes) {
        const layout = layoutByPath.get(entry.path);
        renderExportNode(ctx, entry.node, layout, colors, exportPadding, exportPadding);
      }

      return canvas.toDataURL('image/png');
    }

    async function exportAsPng(requestId, expandMode) {
      try {
        await waitForFonts();
        if (!state.tree) {
          throw new Error('No map is loaded.');
        }
        const sourceTree = expandMode === 'expanded' ? cloneTreeExpanded(state.tree) : state.tree;
        const dataUrl = await exportAsCanvasPng(sourceTree, expandMode);
        post({ type: 'exportPngResult', requestId, dataUrl });
      } catch (error) {
        post({
          type: 'exportPngError',
          requestId,
          message: error instanceof Error ? error.message : 'Failed to export PNG.',
        });
      }
    }

    app.addEventListener('mousedown', (event) => {
      if (event.target.closest('.context-menu') || event.target.closest('#hud')) {
        return;
      }
      closeContextMenu();
      if (event.target.closest('.node')) {
        return;
      }
      state.drag = {
        x: event.clientX,
        y: event.clientY,
        panX: state.panX,
        panY: state.panY,
      };
      app.classList.add('dragging');
    });

    window.addEventListener('mousemove', (event) => {
      if (state.nodeDrag) {
        const moved = Math.abs(event.clientX - state.nodeDrag.startX) + Math.abs(event.clientY - state.nodeDrag.startY);
        if (!state.draggedNodePath && moved > 6) {
          state.draggedNodePath = state.nodeDrag.path;
          state.draggedNodePaths = state.nodeDrag.selectedPaths && state.nodeDrag.selectedPaths.length > 0 ? state.nodeDrag.selectedPaths : [state.nodeDrag.path];
          state.selectedPath = state.nodeDrag.path;
          state.selectedPaths = new Set(state.draggedNodePaths);
          render();
        }
      }

      if (state.draggedNodePath) {
        const nextDropTargetPath = findDropTargetPath(event.clientX, event.clientY);
        if (state.dropTargetPath !== nextDropTargetPath) {
          state.dropTargetPath = nextDropTargetPath;
          render();
        }
        return;
      }

      if (!state.drag) {
        return;
      }
      state.panX = state.drag.panX + (event.clientX - state.drag.x);
      state.panY = state.drag.panY + (event.clientY - state.drag.y);
      setTransform();
    });

    window.addEventListener('mouseup', () => {
      if (state.draggedNodePath) {
        const draggedPath = state.draggedNodePath;
        const draggedPaths = state.draggedNodePaths || [draggedPath];
        const targetPath = state.dropTargetPath;
        state.nodeDrag = null;
        state.draggedNodePath = null;
        state.draggedNodePaths = null;
        state.dropTargetPath = null;
        render();
        if (canDropNodes(draggedPaths, targetPath)) {
          if (draggedPaths.length === 1) {
            post({ type: 'reparentNode', path: draggedPath, targetPath });
          } else {
            post({ type: 'reparentNodes', paths: draggedPaths, targetPath });
          }
        }
        return;
      }

      state.nodeDrag = null;
      state.drag = null;
      app.classList.remove('dragging');
    });

    app.addEventListener('wheel', (event) => {
      event.preventDefault();
      const delta = event.deltaY < 0 ? 1.08 : 0.92;
      zoomAt(state.zoom * delta, event.clientX, event.clientY);
    }, { passive: false });

    window.addEventListener('keydown', (event) => {
      if (!state.tree) {
        return;
      }

      if (event.key === 'Escape' && (state.contextMenuPath || state.zoomMenuOpen)) {
        event.preventDefault();
        closeContextMenu();
        closeZoomMenu();
        return;
      }

      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }

      if (state.editingPath) {
        if (event.key === 'Escape') {
          event.preventDefault();
          cancelEdit();
        }
        return;
      }

      if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          const entry = selectedEntry();
          if (!entry) {
            return;
          }
          const index = currentIndex();
          if (index < 0) {
            return;
          }
          const nextIndex = index + (event.key === 'ArrowUp' ? -1 : 1);
          if (nextIndex < 0 || nextIndex >= state.flatNodes.length) {
            return;
          }
          extendSelectionToPath(state.flatNodes[nextIndex].path);
          return;
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          const entry = selectedEntry();
          if (!entry) {
            return;
          }
          if (event.key === 'ArrowLeft') {
            const segments = entry.path.split('.');
            if (segments.length > 1) {
              segments.pop();
              extendSelectionToPath(segments.join('.'));
            }
          } else if (!entry.node.collapsed && entry.node.children.length > 0) {
            extendSelectionToPath(entry.node.children[0].path);
          }
          return;
        }
      }

      if (event.ctrlKey || event.metaKey) {
        if (!event.altKey && (event.key === 'c' || event.key === 'C')) {
          event.preventDefault();
          copySelectedNodeText();
          return;
        }
        if (!event.altKey && (event.key === 'v' || event.key === 'V')) {
          event.preventDefault();
          pasteIntoSelectedNodeText();
          return;
        }
        if (event.key === 'z' || event.key === 'Z') {
          event.preventDefault();
          post({ type: 'undo' });
          return;
        }
        if (event.key === 'y' || event.key === 'Y') {
          event.preventDefault();
          post({ type: 'redo' });
          return;
        }
        if (event.altKey && /^[1-8]$/.test(event.key)) {
          event.preventDefault();
          post({
            type: 'toggleFlag',
            path: state.selectedPath,
            flag: Number(event.key),
          });
          return;
        }
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          post({ type: 'moveNode', path: state.selectedPath, direction: event.key === 'ArrowUp' ? 'up' : 'down' });
          return;
        }
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveSelectionVertical(-1);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveSelectionVertical(1);
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        navigateHorizontal(-1);
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        navigateHorizontal(1);
        return;
      }
      if (event.key === 'Enter' && event.shiftKey && event.altKey) {
        event.preventDefault();
        post({ type: 'addSibling', path: state.selectedPath, position: 'before' });
        return;
      }
      if (event.key === 'Enter' && event.altKey) {
        event.preventDefault();
        post({ type: 'addSibling', path: state.selectedPath, position: 'after' });
        return;
      }
      if (event.key === 'Enter' && event.shiftKey) {
        event.preventDefault();
        state.pendingSelection = state.selectedPath;
        post({ type: 'addChild', path: state.selectedPath });
        return;
      }
      if (event.key === 'Enter' || event.key === 'F2') {
        event.preventDefault();
        startEdit(state.selectedPath);
        return;
      }
      if (event.key === ' ') {
        event.preventDefault();
        post({ type: 'toggleCollapse', path: state.selectedPath });
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        post({ type: 'deleteNode', path: state.selectedPath });
      }
    });

    zoomControlEl.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleZoomMenu();
    });

    window.addEventListener('mousedown', (event) => {
      if (event.target.closest('#zoomControl') || event.target.closest('.zoom-menu')) {
        return;
      }
      if (state.zoomMenuOpen) {
        closeZoomMenu();
      }
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'document') {
        showError('');
        state.tree = message.tree;
        state.zoom = Math.min(2.2, Math.max(0.35, message.zoom || state.zoom));
        state.measuredHeights.clear();
        render();
        ensureSelectedVisible();
      } else if (message.type === 'error') {
        showError(message.message);
      } else if (message.type === 'operationResult') {
        if (message.selectedPath) {
          state.pendingSelection = message.selectedPath;
        }
        if (message.selectedPaths) {
          state.pendingSelectedPaths = message.selectedPaths;
        } else if (message.selectedPath) {
          state.pendingSelectedPaths = [message.selectedPath];
        }
        if (message.editPath) {
          state.pendingEdit = message.editPath;
          state.pendingSelection = message.editPath;
          state.pendingSelectedPaths = [message.editPath];
          state.pendingCreatedNodePath = message.editPath;
        }
        render();
        ensureSelectedVisible();
      } else if (message.type === 'requestExportPng') {
        void exportAsPng(message.requestId, message.expandMode);
      } else if (message.type === 'operationError') {
        showError(message.message);
      }
    });

    hintToggleEl.addEventListener('click', () => {
      state.hintCollapsed = !state.hintCollapsed;
      renderHint();
    });

    renderHint();
    post({ type: 'ready' });
    setTransform();
