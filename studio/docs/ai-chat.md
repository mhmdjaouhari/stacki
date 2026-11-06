# AI chat

The editor's AI panel supports up to 20 local chats, separate drafts and model choices, and three simultaneous requests. Chat history and image previews are saved in IndexedDB on this browser. Each chat retains the latest 40 messages; requests include up to 12 recent messages. Switching editor panels does not stop a request. Reloading interrupts it and displays a recovery message.

Use the chat title menu to switch or delete chats (arrow keys, Enter and Escape work in it), or the plus button to start another. A dot on the title shows that another chat is working. Enter sends; Shift+Enter inserts a newline. Stop cancels a pending response. Source changes remain proposals until **Apply to draft** is selected, and stale proposals cannot overwrite newer changes. Proposals expire on the server after 15 minutes or a server restart.

While a reply runs, the chat shows the step it is on ("Rendered /", "Read Hero.astro", "Thinking", "Checked the proposal") and how long it has taken. The steps stream from the server as server-sent events on the same request, with a heartbeat every 15 seconds so proxies keep the stream open; proxies must pass `text/event-stream` through unbuffered. Under each reply, a collapsed line gives the model, effort and duration, and opens on the list of steps.

**Apply to draft** checks the change. Studio renders the canvas page and every changed page with a fixed route, before and after writing the files. If a page that rendered before now fails, the files are put back straight away, and the proposal shows the error, with the file and line from the dev server. **Ask to fix** then writes the error into the prompt. Collaborators can see the change for the second or two the check takes, which is why it runs only on Apply, never while the model is proposing. A page that was already failing doesn't count against the change. When the check passes, the outcome names the pages that still render, and **Rendered text** shows how their text changed.

The up arrow in an empty prompt recalls your last message. **Edit** under one of your earlier messages takes you back to it: the replies after it are removed, the changes they applied are undone (newest first, all or nothing, and it says how many first), and the message returns to the composer. Type `@` to attach a page, component or collection file. The model receives it already read, and may edit it.

## Reading a change

Each proposal shows its files with lines added and removed, and the changed lines with three lines of context. A file whose change can no longer apply shows why, and blocks **Apply to draft**. **Review changes** opens the whole files over the canvas, unified or side by side, with unchanged stretches collapsed; Apply and Discard work there too, and Escape closes it. An applied change keeps its diff under the outcome, and **Review** shows it, next to Undo or Redo.

## What the model sees

Besides the prompt and the current file, each request carries an outline of the text the canvas page renders (so values from a CMS or site settings are visible), what the file's `await call()` data returns, and the selected element's source; the composer shows the selection next to the file name. A site owner can write `.stacki/ai.md` with guidance for this site, such as "the home title comes from the CMS settings; change the layout, not the text". It is the only project file the model takes as instructions, and is read up to 8000 characters.

## Provider configuration

Set `AI_BASE_URL`, `AI_MODEL`, and optionally `AI_API_KEY` on the local server or hosted Worker. Add a comma-separated `AI_MODELS` value for additional choices on that same provider. The default model is always included. The server and hosted gateway both enforce this allowlist. Keys stay on the server. A model must support the OpenAI-compatible `/chat/completions` interface; image requests require a vision-capable model. Nothing is enabled or billed by default.

`AI_EFFORTS` sets reasoning-effort levels per model (`deepseek-v4-flash=low,high,max; gpt-6-luna=low,medium,high`), offered next to the model and sent as `reasoning_effort`. `AI_TOOL_MODELS` lists the models that use the provider's native tool calling (`deepseek-v4-flash, glm-5.2`). Those models read files, search the source, render any page and sample a page's data through read-only tools, and can be given more tools by the host (below). Other models use a JSON protocol that can only read files. Tool calling is opt-in because a provider or proxy without support for the `tools` field rejects the request.

Every proposal is checked before it is shown. `.astro` files go through the Astro compiler and their frontmatter and expressions through TypeScript's syntax check; scripts, JSON and CSS go through their parsers; and each change must apply exactly once. Problems go back to the model for up to two rounds of fixes, and whatever remains is shown above the proposal. The check reads syntax only, not types or imports.

For example, with your own local model server:

```sh
AI_BASE_URL=http://127.0.0.1:11434/v1 AI_MODEL=your-default-model AI_MODELS=your-other-model npm run dev
```

## Extending the chat from a host integration

A host that runs Studio's integration itself can pass `studio({ ..., ai: { context, tools } })` (`src/features/ai/aiExtensions.ts`). This is how a CMS adds what Studio can't know, such as its content model or entries, while Studio stays CMS-neutral.

- `context`: functions `({ file, page, signal }) => Promise<{ title, content }[]>`. They are called for every request, and their sections go to the model as data under `host`.
- `tools`: `{ name, description, parameters, run(input, { signal }) }`, offered to `AI_TOOL_MODELS` models next to the built-in ones. `parameters` is a JSON Schema object, and `run` parses its own input.

Both must be read-only. Each call runs under a 15-second deadline. Results are cut at 50,000 characters for a tool and 8000 for a section, and a failure goes back to the model as an error rather than failing the request. Names and shapes are checked when Studio starts.

## Images and voice

Attach, paste, or drop up to four PNG, JPEG, WebP, or GIF images. Images are resized to at most 1600 pixels and compressed to fit the bounded request; GIF attachments use a still frame. Each input file is limited to 20 MB, each prepared image to 180 KB, and total image history to approximately 12 MB. Images are included in the provider request when sent. A follow-up without new images reuses the most recent image references in that chat.

The microphone uses the browser's Web Speech recognition service and inserts dictated text into the composer for review. It needs browser support, a secure context (HTTPS or localhost), and microphone permission. Some browsers send audio to their recognition service. Unsupported browsers and permission failures show a message; no paid transcription API is configured. Switching chats or closing the panel stops the microphone.

## Validation

`npm run verify` runs the repository checks. With a draft Studio running, `npx tsx test/ai.browser.ts` checks chat switching, separate drafts, image preparation and removal, browser persistence, the background-chat dot, the compact diff, the review overlay, and the mobile composer without sending requests to a paid model. Actual model quality, model-specific image support, and live microphone transcription require verification with the deployed provider and browser.
