# Flows API contract (Phase 7, server side)

Board automations. Routes live in `src/server/routes/flows.ts`, mounted at `/` (so `/site-api/boards/:id/flows`). Engine: `src/server/flows/`. Daily job: `src/server/jobs/flows.ts`.

## Access
- Permission `board:flows` (ability `manageFlows`, roles member + admin) AND board admin. Reads are board-admin only too.
- Not your board / no such flow: **404**. Board member below admin: **403**. Archived board, Inbox board or read-only workspace on writes: **409** (`board_archived`, `inbox_board`, `workspace_read_only`).
- Plan: `features.flows` must be on (`403 plan_feature`, text says to upgrade) and the workspace holds up to `limits.maxFlows` flows (`409 limit_reached`). A board holds up to **30** flows. Creating, editing or turning a flow ON needs the plan feature; deleting and turning OFF always work.
- All writes are audited (`flow.create|update|delete`). Responses are `Cache-Control: private, no-store`.

## Shape
```ts
type FlowConfig = {
  trigger:
    | {kind: 'card_created'; laneId?: number | null}          // laneId = only cards created in that lane
    | {kind: 'card_moved';   laneId: number}                  // laneId REQUIRED: the lane the card moved INTO (a move inside the same lane does not fire)
    | {kind: 'daily_due';    dueInDays: number; laneId?: number | null}; // dueInDays 0..30: runs once a day (~05:00 UTC) for open cards whose due date is today + N
  conditions: {labelId?: number | null};                      // card must already carry this label (checked when it runs)
  actions: FlowAction[];                                      // 1..3, run in order
};
type FlowAction =
  | {type: 'assign';    userId: number}                       // active workspace member who can see the board
  | {type: 'add_label'; labelId: number}                      // a label of THIS board
  | {type: 'move';      laneId: number}                       // to the END of an open lane of this board
  | {type: 'comment';   body: string}                         // 1..500 chars, plain text; author is the system ("Flow")
  | {type: 'notify';    target: 'assignees' | 'user'; userId?: number}; // userId required when target = 'user'

type Flow = {
  id: number; boardId: number; name: string;                  // name 1..80
  enabled: boolean;
  trigger: FlowConfig['trigger']; conditions: FlowConfig['conditions']; actions: FlowAction[];
  createdAt: string; updatedAt: string;
  lastRunOn: string | null;                                   // daily_due only: 'YYYY-MM-DD' of the last daily run
  problems: string[];                                         // stable codes: 'lane_gone' | 'label_gone' | 'user_gone' (a reference no longer exists; the flow skips that step until edited)
};
```

## Routes
| Route | Body | Answer |
|---|---|---|
| `GET /boards/:id/flows` | | `{items: Flow[], limit: {max, used, boardMax: 30}, enabled: boolean}` (`enabled` = plan has Flows) |
| `POST /boards/:id/flows` | `{name, enabled?: true, trigger, conditions?: {}, actions}` | `201 {flow}` |
| `PATCH /flows/:id` | any of `name`, `enabled`, `trigger`, `conditions`, `actions` (a given part is replaced whole) | `{flow}` |
| `DELETE /flows/:id` | | `{ok: true}` |

Errors: `422 invalid_input` with `fields` / `fieldCodes`. Field names: `name`, `trigger`, `trigger.laneId`, `trigger.dueInDays`, `conditions.labelId`, `actions` (count), `actions.0.userId`, `actions.1.laneId`, `actions.2.body` ... (index = position in the array). Codes: `required`, `too_long`, `invalid`, `out_of_range`, `not_found` (reference not on this board).
Validation also rejects a flow that could loop on itself: a `card_moved` flow into lane X with a `move` action back to lane X.

## Behaviour (for UI copy)
- Runs right after the card write commits (create cards, move card); a failing flow never fails the user's action.
- Actions are done by the **system**: activity rows have no actor (`actorId` null, UI shows "Flow") and `meta: {flowId, flowName}`. Activity rows reuse the normal kinds (`card.member_added`, `card.label_added`, `card.moved`, `comment.created`) with `meta.flowId` and `meta.flowName` added, so the card's activity list already renders them; show "Flow" (or the flow name) when `actorName` is null and `meta.flowId` is set. `notify` writes no activity. Comments created by a flow have `authorId: null` (shown as a deleted/system author).
- Loop safety: chain depth max 3 (a move action can fire another flow), the same flow never runs twice on the same card in a chain, at most 20 actions per user action; a full lane (500) or archived card/lane makes that step skip.
- Idempotent: assign / label are no-ops when already there; `daily_due` claims each flow once per UTC day (`lastRunOn`), so a retried job never repeats it; at most 200 cards per flow per day.
- Notifications reuse existing kinds: `assigned` for assign, `due_soon` for daily_due, `comment` otherwise.
