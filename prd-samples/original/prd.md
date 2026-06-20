# PRD: Kanban Board Core Logic & API
**Feature Slug**: kanban-board-core-logic-api

## Overview
This feature implements the core state management and API layer for a fully functional Kanban Board within a BunJS runtime environment. It enables users to create, view, and move cards between columns without any database persistence, relying entirely on in-memory state managed through typed TypeScript modules.

## Goals
- Provide a robust, type-safe in-memory store for board state management.
- Expose RESTful API endpoints to handle card movement and retrieval operations.
- Ensure all logic is strictly typed with BunJS native performance characteristics.

## Technical Approach
The application will be built using BunJS as the runtime with TypeScript configured in strict mode. All source files will utilize the `.mts` extension to enforce module resolution rules. The architecture follows a modular service pattern: types are defined first, followed by state management logic, then API route handlers, and finally an HTTP server entry point. No external database dependencies will be used; all data resides in memory for the duration of the server process.

Each TypeScript interface or type alias lives in its own `.mts` file; a barrel `src/types/index.mts` re-exports all of them.

## Tasks
- [ ] **TASK-001**: Initialize Project Structure with Strict TypeScript Config
  - **Description**: Create `package.json` with `"type": "module"` and a `"typecheck": "tsc --noEmit"` script. Install `typescript` and `bun-types` as dev dependencies via `bun add -d typescript bun-types`. Create `tsconfig.json` with `"strict": true`, `"target": "ESNext"`, `"module": "ESNext"`, `"moduleResolution": "bundler"`, and `"types": ["bun-types"]`. Create `src/types/index.mts` as an empty barrel. Create empty placeholder `.gitkeep` files inside `src/services/`, `src/routes/`, and `src/tests/` so the directories exist.
  - **Acceptance**: `tsconfig.json` exists with `"strict": true`. `src/types/index.mts` exists. Directories `src/services/`, `src/routes/`, and `src/tests/` exist.
  - **Test Command**: `ls tsconfig.json && ls src/types/index.mts && ls src/services/ && ls src/routes/ && ls src/tests/`

- [ ] **TASK-002**: Define Core Domain Types (`types/`)
  - **Depends On**: TASK-001
  - **Description**: Create one TypeScript interface per `.mts` file following the one-interface-per-file rule: `src/types/card.mts` exporting `Card` (`id: string`, `title: string`, `columnId: string`), `src/types/column.mts` exporting `Column` (`id: string`, `title: string`, `order: number`), and `src/types/board-state.mts` exporting `BoardState` (`columns: Column[]`, `cards: Card[]`). Update `src/types/index.mts` to re-export all three. Also create `src/types/board.test.mts` using `bun:test` that imports each type from the barrel and verifies that objects conforming to each interface satisfy their structural shape.
  - **Acceptance**: All three interface files exist. Column has `order: number`. No `any` types in any file. Barrel re-exports all types. `bun test src/types/board.test.mts` passes.
  - **Test Command**: `bun test src/types/board.test.mts`

- [ ] **TASK-003**: Implement In-Memory Store Service (`services/store.mts`)
  - **Depends On**: TASK-002
  - **Description**: Create `src/services/store.mts` with a singleton store class. Methods: `getBoard(): BoardState`, `addColumn(title: string): Column` (generates UUID via `crypto.randomUUID()`, appends to columns array with incrementing `order`), `addCard(title: string, columnId: string): Card` (generates UUID, throws if column not found), `moveCard(cardId: string, targetColumnId: string): BoardState` (updates `columnId` on the card, throws if card or target column not found). Export a single `store` instance. Also create `src/services/store.test.mts` using `bun:test` with `beforeEach` that resets state, and tests covering `addColumn`, `addCard`, `moveCard`, and error cases.
  - **Acceptance**: Methods return updated state objects. Initial state has empty columns and cards arrays. State persists across calls within the same process. Tests cover success and error paths. `bun test src/services/store.test.mts` passes.
  - **Test Command**: `bun test src/services/store.test.mts`

- [ ] **TASK-004**: Implement Move Card Validation Logic (`services/validation.mts`)
  - **Depends On**: TASK-002
  - **Description**: Create `src/services/validation.mts` that exports `validateMoveCard(state: BoardState, cardId: string, targetColumnId: string): boolean`. Returns `true` when the card exists in state and the target column exists in state. Returns `false` in all other cases. No state mutations or side effects. Also create `src/services/validation.test.mts` using `bun:test` with test cases for valid moves, missing card, missing column, and empty state.
  - **Acceptance**: Returns `true` only when both card and target column exist. Returns `false` for any missing entity. No mutations to state. `bun test src/services/validation.test.mts` passes.
  - **Test Command**: `bun test src/services/validation.test.mts`

- [ ] **TASK-005**: Create API Endpoint for Get Board State (`routes/getBoard.mts`)
  - **Depends On**: TASK-003
  - **Description**: Create `src/routes/getBoard.mts` that exports `handleGetBoard(req: Request): Response`. Reads the current state from the `store` singleton and returns it as JSON with `Content-Type: application/json` and HTTP 200. Also create `src/routes/getBoard.test.mts` using `bun:test` that calls `handleGetBoard` directly (no live server required) and asserts the response status, content-type header, and that the body contains `columns` and `cards` arrays.
  - **Acceptance**: Returns HTTP 200 with `Content-Type: application/json`. Response body is valid JSON with `columns` and `cards` arrays. `bun test src/routes/getBoard.test.mts` passes.
  - **Test Command**: `bun test src/routes/getBoard.test.mts`

- [ ] **TASK-006**: Create API Endpoint for Move Card (`routes/moveCard.mts`)
  - **Depends On**: TASK-003, TASK-004
  - **Description**: Create `src/routes/moveCard.mts` that exports `handleMoveCard(req: Request): Promise<Response>`. Parses JSON body expecting `{ cardId: string, targetColumnId: string }`. Calls `validateMoveCard` against the current store state. On valid input, calls `store.moveCard` and returns HTTP 200 with updated board state JSON. On invalid input or missing fields, returns HTTP 400 with a JSON error message. Also create `src/routes/moveCard.test.mts` using `bun:test` that calls `handleMoveCard` directly with setup state and asserts both success and failure responses.
  - **Acceptance**: Returns HTTP 200 with updated JSON state on success. Returns HTTP 400 on validation failure or missing body fields. Store is updated after a successful call. `bun test src/routes/moveCard.test.mts` passes.
  - **Test Command**: `bun test src/routes/moveCard.test.mts`

- [ ] **TASK-007**: Create API Endpoint for Add Card (`routes/addCard.mts`)
  - **Depends On**: TASK-003
  - **Description**: Create `src/routes/addCard.mts` that exports `handleAddCard(req: Request): Promise<Response>`. Parses JSON body expecting `{ title: string, columnId: string }`. Validates that the target column exists in the store. On success, calls `store.addCard` and returns HTTP 201 with the newly created card as JSON. Returns HTTP 400 with a JSON error if the column does not exist or body fields are missing. Also create `src/routes/addCard.test.mts` using `bun:test` that calls `handleAddCard` directly with setup state and asserts both success (201) and failure (400) cases.
  - **Acceptance**: Returns HTTP 201 with the created card object on success. Card has a unique UUID `id`. Returns HTTP 400 if column does not exist. `bun test src/routes/addCard.test.mts` passes.
  - **Test Command**: `bun test src/routes/addCard.test.mts`

- [ ] **TASK-008**: Configure HTTP Server Entry Point (`index.mts`)
  - **Depends On**: TASK-005, TASK-006, TASK-007
  - **Description**: Create `src/index.mts` that starts a Bun HTTP server on port 3000 using `Bun.serve`. Route incoming requests to `handleGetBoard`, `handleMoveCard`, or `handleAddCard` based on method and path. Return HTTP 404 for unmatched routes. Add `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Methods: GET, POST, OPTIONS` headers to all responses. Also create `src/tests/server.test.mts` using `bun:test` that imports the route handlers directly (without starting a real server) and calls them with synthetic `Request` objects to assert correct routing behavior. Use `afterAll` to clean up any resources.
  - **Acceptance**: Route handlers are exported from `src/index.mts` and correctly dispatched by path and method. CORS headers are present on responses. `bun test src/tests/server.test.mts` passes.
  - **Test Command**: `bun test src/tests/server.test.mts`

- [ ] **TASK-009**: Serve Static Frontend Assets
  - **Depends On**: TASK-008
  - **Description**: Create `public/index.html` as a minimal HTML page with `<title>Kanban Board</title>` in the `<head>`. Update the request router in `src/index.mts` to serve files from the `public/` directory using `Bun.file` for requests that do not match any API route. Return HTTP 404 if the file does not exist. Also create `src/tests/static.test.mts` using `bun:test` that starts a temporary server via `Bun.serve` on a random port (use `port: 0`), sends a GET request to `/`, asserts the response body contains `<title>Kanban Board</title>`, and stops the server in `afterAll` via `server.stop()`.
  - **Acceptance**: GET `/` returns HTTP 200 with HTML body containing `<title>Kanban Board</title>`. Non-existent static paths return 404. `bun test src/tests/static.test.mts` passes.
  - **Test Command**: `bun test src/tests/static.test.mts`

- [ ] **TASK-010**: Implement End-to-End Integration Test (`tests/e2e.test.mts`)
  - **Depends On**: TASK-008
  - **Description**: Create `src/tests/e2e.test.mts` using `bun:test`. In `beforeAll`, start a temporary server via `Bun.serve` on port 0 (random port) and record the assigned port from `server.port`. In `afterAll`, stop it via `server.stop()`. The test suite must: (1) add a column directly via `store.addColumn`, (2) POST to `/api/board/cards` to add a card to that column, (3) add a second column, (4) POST to `/api/board/move` to move the card to the second column, (5) GET `/api/board` and assert the card's `columnId` matches the second column's `id`. Reset store state in `beforeAll` so the test is isolated.
  - **Acceptance**: All assertions pass. Server starts and stops cleanly within the test lifecycle. Final GET `/api/board` confirms the card is in the target column. `bun test src/tests/e2e.test.mts` passes.
  - **Test Command**: `bun test src/tests/e2e.test.mts`

## Acceptance Criteria
- [ ] All TypeScript files use `.mts` extension and strict mode configuration is active.
- [ ] Card movement updates the in-memory state immediately without database calls.
- [ ] API endpoints return correct HTTP status codes (200, 201, 400) for all operations.

## Out of Scope
- User authentication or authorization mechanisms.
- Persistent storage (database or file system) for board data.
- Real-time WebSocket updates for multi-user collaboration.
- Drag-and-drop visual implementation in the browser (logic only).
