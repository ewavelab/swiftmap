# SwiftMap File Format

This document specifies the `.swiftmap` text format used to store SwiftMap mind maps.

## Overview

A `.swiftmap` file is a UTF-8 plain text file containing one tree. Each non-empty line represents one node. The line indentation defines parent-child relationships.

A document has exactly one root node. The root is the first non-empty line and must not be indented.

## Canonical Form

SwiftMap writes files in canonical form:

- Line endings may be LF (`\n`) or CRLF (`\r\n`).
- Each node is written on one line.
- Each child level is indented by two spaces.
- Empty lines are omitted.
- Priority is emitted before status and tags.
- Priority is emitted separately as `[]`, `Low priority`, `Medium priority`, or `High priority`.
- Status is emitted separately as `[]`, `In progress`, `Blocked`, `Done`, or `Rejected`.
- Tags are emitted separately as `[]`, `Question`, `Task`, or `Idea`.
- Node names are trimmed and cannot contain line breaks.
- The file does not require a trailing newline.

## Line Structure

Each node line has this structure:

```text
INDENT SIGN SPACE PRIORITY SPACE STATUS SPACE TAGS [SPACE NAME]
```

Where:

- `INDENT` is zero or more indentation characters. In canonical form this is two spaces per depth level.
- `SIGN` is `+` for expanded or `-` for collapsed.
- `PRIORITY` is a square-bracketed single priority value or `[]`.
- `STATUS` is a square-bracketed single status value or `[]`.
- `TAGS` is a square-bracketed comma-separated list of zero or more tags.
- `NAME` is optional single-line text after the tags token.

Examples:

```text
+ [] [] [] Root
  + [High priority] [Done] [] Finished task
  - [High priority] [Rejected] [Question,Task] Needs review
```

## Canonical Grammar

This grammar describes the canonical serialized form.

```ebnf
document        = node-line { line-break node-line } [ line-break ] ;
node-line       = indent sign space priority space status space tags [ space name ] ;
indent          = { "  " } ;
sign            = "+" | "-" ;
priority        = "[" [ priority-value ] "]" ;
priority-value  = "Low priority" | "Medium priority" | "High priority" ;
status          = "[" [ status-value ] "]" ;
status-value    = "In progress" | "Blocked" | "Done" | "Rejected" ;
tags            = "[" [ tag-list ] "]" ;
tag-list        = tag { "," tag } ;
tag             = "Question" | "Task" | "Idea" ;
name            = { name-character } ;
line-break      = "\n" | "\r\n" ;
space           = " " ;
```

`name-character` is any Unicode scalar value except carriage return (`\r`) or line feed (`\n`). Implementations should trim leading and trailing whitespace from node names when reading or writing. A document should use one line ending style consistently.

## Tree Construction

The tree is constructed by processing non-empty lines from top to bottom:

1. The first non-empty line creates the root node and must have depth `0`.
2. A later line becomes a child of the nearest preceding line with a lower indentation depth.
3. Sibling order is the same as line order.
4. In canonical form, a line can increase depth by at most one level relative to the preceding non-empty line.

Canonical depth is computed as the number of leading spaces divided by two. A canonical file must not use odd numbers of leading spaces.

## Status, Priority, and Tags

The supported status values are:

| Status | Meaning |
| --- | --- |
| `In progress` | Active work item |
| `Blocked` | Work item is blocked |
| `Done` | Completed item |
| `Rejected` | Rejected or discarded item |

The supported priority values are:

| Priority | Meaning |
| --- | --- |
| `Low priority` | Low-priority item |
| `Medium priority` | Medium-priority item |
| `High priority` | High-priority item |

The supported tags are:

| Tag | Meaning |
| --- | --- |
| `Question` | Item requiring a decision |
| `Task` | Actionable task |
| `Idea` | Idea or proposal |

Status values must follow these rules:

- Use `[]` for no status.
- Write at most one status value.
- Write the status in this order: `In progress`, `Blocked`, `Done`, `Rejected`.

Priority values must follow these rules:

- Use `[]` for no priority.
- Write at most one priority value.
- Write the priority in this order: `Low priority`, `Medium priority`, `High priority`.

Tag lists must follow these rules:

- Use `[]` for no tags.
- Do not include spaces around commas inside the brackets.
- Do not repeat a tag.
- Write tags in this exact order: `Question`, `Task`, `Idea`.

Valid examples:

```text
[]
[In progress]
[Blocked]
[Done]
[Rejected]

[]
[Low priority]
[Medium priority]
[High priority]

[]
[Question]
[Question,Task]
[Question,Task,Idea]
```

Invalid examples:

```text
[Idea,Done]
[High priority,Task]
[Done,Done]
[Unknown]
[Low priority,Question,Task]
[In progress,Blocked]
```

## Names

Node names are plain text:

- Names are single-line.
- Names have no inline formatting syntax.
- Leading and trailing whitespace is ignored.
- Empty names are valid.

Because every node line starts with `PRIORITY STATUS TAGS`, a name may contain characters that look like priority values, status values, tags, punctuation, or additional spaces after the first name character.

## Reader Compatibility

The current SwiftMap extension reader accepts a small superset of the canonical form:

- Empty files are treated as a single expanded root node named `Root`.
- Blank lines are ignored.
- Tabs in indentation are treated as two spaces.
- Child indentation is based on relative indentation width, so non-canonical indentation may still parse if each child line is more indented than its parent line.
- The reader accepts the canonical priority-status-tags form, the older status-priority-tags form, the older priority/tag-only forms in either order, and legacy single-token aspect lines such as `+ [High priority,Done] Name`.
- Empty node names may be written either as `+ [] [] []` or with a trailing separator space as `+ [] [] [] `.

Writers should still emit canonical form.

## Complete Example

```text
+ [] [] [] Project Planning
  + [High priority] [Done] [] Scope
    + [] [Done] [] Identify goals
    + [Medium priority] [In progress] [Task] Define success metrics
  + [Medium priority] [] [Idea] Discovery
    + [] [] [Question] Interview users
  - [] [Rejected] [] Deprecated Ideas
    + [] [Rejected] [Task] Build custom sync engine
  + [High priority] [In progress] [Task] Delivery
```
