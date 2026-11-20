# Issue tracker: GitHub

Issues and specs live as GitHub issues in firstBitSportivnaya/interview-trainer.
Provider is github. Use the GitKraken MCP namespace `user-GitKraken`. Do not call `gh`.

Repository for every call: repository_organization=firstBitSportivnaya, repository_name=interview-trainer, provider=github.

## Conventions

- **Create an issue**: `issues_create` with title, body, and optional labels and assignees.
- **Read an issue**: `issues_get_detail` with issue_id set to the issue number.
- **List issues**: `issues_assigned_to_me` with assigned_to_me=false, is_closed as needed, and fields=number,title,status. Pass repository_organization and repository_name.
- **Comment**: `issues_add_comment` with issue_id and comment.
- **Labels on create**: pass labels by these exact names. There is no separate label-edit call.
- **Sub-issues and blocking**: write `Part of #<parent>` and `Blocked by: #<n>, #<n>` at the top of the child body. A ticket is unblocked when every listed blocker is closed.
- **Claim**: pass assignees on create. Assignment after creation is not available here.
- **Close**: not available from GitKraken. Leave a comment that the issue is ready to close and say so in the reply to the user.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says "publish to the issue tracker"

Create a GitHub issue as in **Create an issue**.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue**.

## Wayfinding operations

- **Map**: one issue labelled wayfinder:map.
- **Child ticket**: an issue whose body starts with `Part of #<map>`. Labels: wayfinder:research, wayfinder:prototype, wayfinder:grilling, or wayfinder:task.
- **Blocking**: a `Blocked by: #<n>, #<n>` line at the top of the child body.
- **Frontier**: open children of the map, skipping any with an open blocker or an assignee. First in map order wins.
- **Resolve**: comment the answer on the child, then tell the user the issue number to close. Append a context pointer to the map by commenting on the map.
