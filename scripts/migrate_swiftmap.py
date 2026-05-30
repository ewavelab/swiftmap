#!/usr/bin/env python3
"""Migrate legacy SwiftMap files to the new tags + priority format.

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


TAG_ORDER = ["Done", "Rejected", "Question", "Task", "Idea"]
PRIORITY_ORDER = ["Low priority", "Medium priority", "High priority"]
ASPECT_ORDER = TAG_ORDER + PRIORITY_ORDER
ASPECT_RANK = {name: index for index, name in enumerate(ASPECT_ORDER)}

LINE_RE = re.compile(r"^([+-])\s+(\[[^\]]*\])(?:\s+(\[[^\]]*\]))?(?:\s(.*))?\s*$")
ASPECT_RE = re.compile(
    r"^\[(Done|Rejected|Question|Task|Idea|Low priority|Medium priority|High priority)"
    r"(,(Done|Rejected|Question|Task|Idea|Low priority|Medium priority|High priority))*\]$"
)


@dataclass
class Node:
    name: str
    collapsed: bool
    tags: list[str] = field(default_factory=list)
    priority: str = ""
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
    lines = text.replace("\r", "").split("\n") if text else ["+ [] [] Root"]
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
        first_token = match.group(2)
        second_token = match.group(3)
        name = sanitize_name(match.group(4) or "")

        if second_token is None:
            tags, priority = split_legacy_aspects(parse_aspect_tokens(first_token, raw_line), first_token, raw_line)
        else:
            tags, priority = parse_aspect_pair(first_token, second_token, raw_line)

        node = Node(name=name, collapsed=collapsed, tags=tags, priority=priority)

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


def split_legacy_aspects(tokens: list[str], token: str, raw_line: str) -> tuple[list[str], str]:
    tags = [token_name for token_name in tokens if is_tag(token_name)]
    priority_tokens = [token_name for token_name in tokens if is_priority(token_name)]
    if len(priority_tokens) > 1:
        raise ValueError(f'Only one priority is allowed, got "{token}"')
    if len(set(tags)) != len(tags):
        raise ValueError(f'Duplicated tags token "{token}"')
    tags = sorted(tags, key=tag_rank)
    return tags, (priority_tokens[0] if priority_tokens else "")


def parse_aspect_pair(first_token: str, second_token: str, raw_line: str) -> tuple[list[str], str]:
    try:
        priority = parse_priority_token(first_token, raw_line)
        tags = parse_tags_token(second_token, raw_line)
        return tags, priority
    except ValueError as first_error:
        try:
            tags = parse_tags_token(first_token, raw_line)
            priority = parse_priority_token(second_token, raw_line)
            return tags, priority
        except ValueError:
            raise first_error


def parse_tags_token(token: str, raw_line: str) -> list[str]:
    tokens = parse_aspect_tokens(token, raw_line)
    if any(is_priority(value) for value in tokens):
        raise ValueError(f'Tags token cannot contain priority values, got "{token}"')
    if tokens != sorted(tokens, key=tag_rank):
        raise ValueError(f'Tags must be ordered as [Done,Rejected,Question,Task,Idea], got "{token}"')
    if len(set(tokens)) != len(tokens):
        raise ValueError(f'Duplicated tags token "{token}"')
    return tokens


def parse_priority_token(token: str, raw_line: str) -> str:
    tokens = parse_aspect_tokens(token, raw_line)
    if not tokens:
        return ""
    if len(tokens) != 1:
        raise ValueError(f'Priority token can contain only one value, got "{token}"')
    if not is_priority(tokens[0]):
        raise ValueError(
            'Priority token must be empty or one of [Low priority,Medium priority,High priority], '
            f'got "{token}"'
        )
    return tokens[0]


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
        status = "-" if node.collapsed else "+"
        priority = f"[{node.priority}]" if node.priority else "[]"
        tags = f"[{','.join(node.tags)}]" if node.tags else "[]"
        lines.append(f"{indent}{status} {priority} {tags} {sanitize_name(node.name)}")
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


def is_tag(token: str) -> bool:
    return token in TAG_ORDER


def is_priority(token: str) -> bool:
    return token in PRIORITY_ORDER


def tag_rank(token: str) -> int:
    return ASPECT_RANK[token]


def aspect_rank(token: str) -> int:
    return ASPECT_RANK[token]


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
