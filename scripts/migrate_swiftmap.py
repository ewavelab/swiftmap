#!/usr/bin/env python3
"""Migrate legacy SwiftMap files to the priority + status + tags format.

Usage:
  python3 scripts/migrate_swiftmap.py file1.swiftmap file2.swiftmap ...

For every file, the script writes a sibling backup named ``<name>.backup``
before replacing the original file with the migrated version.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path


STATUS_ORDER = ["In progress", "Blocked", "Done", "Rejected"]
PRIORITY_ORDER = ["Low priority", "Medium priority", "High priority"]
TAG_ORDER = ["Question", "Task", "Idea"]

ASPECT_ORDER = PRIORITY_ORDER + STATUS_ORDER + TAG_ORDER
ASPECT_RANK = {name: index for index, name in enumerate(ASPECT_ORDER)}

LINE_RE = re.compile(r"^([+-])\s+(\[[^\]]*\])(?:\s+(\[[^\]]*\]))?(?:\s+(\[[^\]]*\]))?(?:\s(.*))?\s*$")
ASPECT_RE = re.compile(
    r"^\[(In progress|Blocked|Done|Rejected|Low priority|Medium priority|High priority|Question|Task|Idea)"
    r"(,(In progress|Blocked|Done|Rejected|Low priority|Medium priority|High priority|Question|Task|Idea))*\]$"
)


@dataclass
class Node:
    name: str
    collapsed: bool
    status: str = ""
    priority: str = ""
    tags: list[str] = field(default_factory=list)
    children: list["Node"] = field(default_factory=list)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+", help="SwiftMap files to migrate")
    args = parser.parse_args(argv)

    for raw_path in args.files:
        path = Path(raw_path)
        if not path.exists():
            print(f"error: file does not exist: {path}", file=sys.stderr)
            return 1
        root = parse_document(path.read_text(encoding="utf-8"))
        migrated = serialize_document(root)

        backup_path = path.with_name(path.name + ".backup")
        shutil.copy2(path, backup_path)
        write_atomic(path, migrated)
        print(f"migrated {path} -> {backup_path}")

    return 0


def parse_document(text: str) -> Node:
    lines = text.replace("\r", "").split("\n") if text else ["+ [] [] [] Root"]
    stack: list[tuple[int, Node]] = []
    root: Node | None = None

    for raw_line in lines:
        if not raw_line.strip():
            continue

        indent_text = raw_line[: len(raw_line) - len(raw_line.lstrip())]
        indent = len(indent_text.replace("\t", "  "))
        content = raw_line[len(indent_text) :]
        match = LINE_RE.match(content)
        if not match:
            raise ValueError(f'Invalid SwiftMap line: "{raw_line}"')

        collapsed = match.group(1) == "-"
        tokens = [match.group(2), match.group(3), match.group(4)]
        name = sanitize_name(match.group(5) or "")
        status, priority, tags = parse_aspects([token for token in tokens if token], raw_line)
        node = Node(name=name, collapsed=collapsed, status=status, priority=priority, tags=tags)

        while stack and stack[-1][0] >= indent:
            stack.pop()

        if root is None:
            if indent != 0:
                raise ValueError("Root node must not be indented.")
            root = node
            stack.append((indent, node))
            continue

        if not stack:
            raise ValueError(f'Invalid indentation near "{raw_line}"')

        stack[-1][1].children.append(node)
        stack.append((indent, node))

    if root is None:
        root = Node(name="Root", collapsed=False)

    return root


def parse_aspects(tokens: list[str], raw_line: str) -> tuple[str, str, list[str]]:
    values = [value for token in tokens for value in parse_aspect_tokens(token, raw_line)]

    status_values = [value for value in values if is_status(value)]
    priority_values = [value for value in values if is_priority(value)]
    tags = [value for value in values if is_tag(value)]

    if len(status_values) > 1:
        raise ValueError(f'Only one status is allowed, got "{raw_line}"')
    if len(priority_values) > 1:
        raise ValueError(f'Only one priority is allowed, got "{raw_line}"')
    if len(set(tags)) != len(tags):
        raise ValueError(f'Duplicated tags token "{raw_line}"')

    tags = sorted(tags, key=tag_rank)
    return status_values[0] if status_values else "", priority_values[0] if priority_values else "", tags


def parse_aspect_tokens(token: str, raw_line: str) -> list[str]:
    if token == "[]":
        return []
    if not ASPECT_RE.match(token):
        raise ValueError(f'Invalid aspects token "{token}" in line "{raw_line}"')
    return token[1:-1].split(",")


def serialize_document(root: Node) -> str:
    lines: list[str] = []

    def visit(node: Node, depth: int) -> None:
        indent = "  " * depth
        priority = f"[{node.priority}]" if node.priority else "[]"
        status = f"[{node.status}]" if node.status else "[]"
        tags = f"[{','.join(node.tags)}]" if node.tags else "[]"
        lines.append(f"{indent}{'-' if node.collapsed else '+'} {priority} {status} {tags} {sanitize_name(node.name)}")
        for child in node.children:
            visit(child, depth + 1)

    visit(root, 0)
    return "\n".join(lines)


def write_atomic(path: Path, content: str) -> None:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=str(path.parent)) as tmp:
        tmp.write(content)
        tmp_path = Path(tmp.name)
    os.replace(tmp_path, path)


def sanitize_name(value: str) -> str:
    return value.replace("\r", " ").replace("\n", " ").strip()


def is_status(token: str) -> bool:
    return token in STATUS_ORDER


def is_priority(token: str) -> bool:
    return token in PRIORITY_ORDER


def is_tag(token: str) -> bool:
    return token in TAG_ORDER


def tag_rank(token: str) -> int:
    return ASPECT_RANK[token]


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
