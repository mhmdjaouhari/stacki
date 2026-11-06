# AI chat

The editor's AI panel supports up to 20 local chats, separate drafts and model choices, and three simultaneous requests. Chat history and image previews are saved in IndexedDB on this browser. Each chat retains the latest 40 messages; requests include up to 12 recent messages. Switching editor panels does not stop a request. Reloading interrupts it and displays a recovery message.

Use the chat title menu to switch or delete chats (arrow keys, Enter and Escape work in it), or the plus button to start another. A dot on the title shows that another chat is working. Enter sends; Shift+Enter inserts a newline. Stop cancels a pending response. Source changes remain proposals until **Apply to draft** is selected, and stale proposals cannot overwrite newer changes. Proposals expire on the server after 15 minutes or a server restart.

## Reading a change

Each proposal shows its files with lines added and removed, and the changed lines with three lines of context. A file whose change can no longer apply shows why, and blocks **Apply to draft**. **Review changes** opens the whole files over the canvas, unified or side by side, with unchanged stretches collapsed; Apply and Discard work there too, and Escape closes it. An applied change keeps its diff under the outcome, and **Review** shows it, next to Undo or Redo.

## What the model sees

Besides the prompt and the current file, each request carries an outline of the text the canvas page renders (so values from a CMS or site settings are visible), what the file's `await call()` data returns, and the selected element's source; the composer shows the selection next to the file name. A site owner can write `.stacki/ai.md` with guidance for this site, such as "the home title comes from the CMS settings; change the layout, not the text". It is the only project file the model takes as instructions, and is read up to 8000 characters.

## Provider configuration

Set `AI_BASE_URL`, `AI_MODEL`, and optionally `AI_API_KEY` on the local server or hosted Worker. Add a comma-separated `AI_MODELS` value for additional choices on that same provider. The default model is always included. The server and hosted gateway both enforce this allowlist. Keys stay on the server. A model must support the OpenAI-compatible `/chat/completions` interface; image requests require a vision-capable model. Nothing is enabled or billed by default.

For example, with your own local model server:

```sh
AI_BASE_URL=http://127.0.0.1:11434/v1 AI_MODEL=your-default-model AI_MODELS=your-other-model npm run dev
```

## Images and voice

Attach, paste, or drop up to four PNG, JPEG, WebP, or GIF images. Images are resized to at most 1600 pixels and compressed to fit the bounded request; GIF attachments use a still frame. Each input file is limited to 20 MB, each prepared image to 180 KB, and total image history to approximately 12 MB. Images are included in the provider request when sent. A follow-up without new images reuses the most recent image references in that chat.

The microphone uses the browser's Web Speech recognition service and inserts dictated text into the composer for review. It needs browser support, a secure context (HTTPS or localhost), and microphone permission. Some browsers send audio to their recognition service. Unsupported browsers and permission failures show a message; no paid transcription API is configured. Switching chats or closing the panel stops the microphone.

## Validation

`npm run verify` runs the repository checks. With a draft Studio running, `npx tsx test/ai.browser.ts` checks chat switching, separate drafts, image preparation and removal, browser persistence, the background-chat dot, the compact diff, the review overlay, and the mobile composer without sending requests to a paid model. Actual model quality, model-specific image support, and live microphone transcription require verification with the deployed provider and browser.
