# WordEditor

An Angular app for opening, editing and reviewing Word (`.docx`) documents in the browser, with no editor server
and no licence. It has a document list and a built-in contract editor that supports tracked changes, comments and an
initiator → approver review flow. Every save is stored as a new version.

Built with Angular 21 (standalone components) and [JSZip](https://stuk.github.io/jszip/) for reading and writing
`.docx` files.

## Requirements

- Node.js 20.19+, 22.12+ or 24+ and npm
- The ContractsEditor .NET API (`Azm.Wopi.SampleHost`) running on `http://localhost:5080`. It is **not** part of
  this repo. The app stores and versions documents through it.

## Getting started

```bash
npm install
npm start
```

Open http://localhost:4200. The dev server sends `/api/*` to `http://127.0.0.1:5080` (see `proxy.conf.json`).
If your API runs somewhere else, change `target` there.

## Using the app

- **`/documents`**: lists documents. Create a blank document, upload a `.docx`, download any version, or open one.
- **`/documents/:id/edit?mode=…`**: opens a document in the editor. If you leave out `mode`, you get the richest
  mode your rights allow. The server refuses modes you may not use.

| Mode      | What the user can do                                                            |
| --------- | ------------------------------------------------------------------------------- |
| `edit`    | Full editing                                                                    |
| `comment` | Read and add comments                                                           |
| `suggest` | Initiator: every edit is recorded as a tracked change in the user's name        |
| `approve` | Approver: accept or reject changes; the approver's own edits are also tracked   |
| `view`    | Read only                                                                       |

If someone else saved after you opened the document, your save is refused (`409`), so no one's changes get
overwritten. The app warns you before you leave with unsaved changes.

### Development users

For this POC, the API identifies the caller from an `X-Dev-User` header that `src/app/dev-user.ts` adds to every
request. This works in Development builds only. Switching between `Initiator (Ahmed)` and `Approver (Sara)` lets one
browser play both sides of the review flow. In a real app, remove `devUserInterceptor` and use your own auth
interceptor.

## Project structure

```
src/app/
  documents/          DocumentsService (API client), models, routes, document list page
  contract-editor/    <azm-contract-editor> component and the /documents/:id/edit page
  dev-user.ts         POC-only X-Dev-User interceptor
public/contract-editor/
  index.html          The editor page, loaded in a same-origin iframe
  editor.js           Editor UI: editing, comments, tracked changes, review
  docx-core.js        .docx parsing and writing
```

The editor runs in an iframe so its global styles and scripts stay separate from the app. `ContractEditorComponent`
downloads the document through the API, passes the bytes to the iframe with `postMessage`, and saves what the
editor sends back as a new version.

## Embedding in another Angular app

1. Copy `src/app/documents`, `src/app/contract-editor` and `public/contract-editor` into your app.
2. Register the API client in `app.config.ts`:
   ```ts
   provideHttpClient(withInterceptors([yourAuthInterceptor])),
   provideDocuments({ apiBase: environment.apiUrl }),
   ```
3. Add the routes behind your auth guard:
   ```ts
   { path: 'documents', canActivate: [authGuard], children: DOCUMENT_ROUTES }
   ```
   Or use the component directly. It fills its container, so give the container a height:
   ```html
   <azm-contract-editor [fileId]="id" mode="suggest" (saved)="onSaved($event)"></azm-contract-editor>
   ```

The component emits `loaded`, `saved`, `failed` and `dirtyChange` events.

## API

`DocumentsService` uses these endpoints:

| Method | Endpoint                                          | Purpose                                |
| ------ | ------------------------------------------------- | -------------------------------------- |
| GET    | `/api/documents`                                  | List documents                         |
| POST   | `/api/documents`                                  | Upload a `.docx` (multipart `file`)    |
| POST   | `/api/documents/new?name=`                        | Create a blank document                |
| GET    | `/api/documents/{id}/access?mode=`                | Get the granted mode and allowed modes |
| GET    | `/api/documents/{id}/download?v=`                 | Download the latest or a given version |
| GET    | `/api/documents/{id}/versions`                    | Version history                        |
| PUT    | `/api/documents/{id}/content?mode=&baseVersion=`  | Save as a new version                  |

## Scripts

| Command         | Description                                  |
| --------------- | -------------------------------------------- |
| `npm start`     | Dev server at http://localhost:4200          |
| `npm run build` | Production build to `dist/`                  |
| `npm run watch` | Development build, rebuilds on change        |
| `npm test`      | Unit tests with Vitest                       |
