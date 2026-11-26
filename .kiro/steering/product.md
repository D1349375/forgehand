# Forgehand

Forgehand is a voice- and hand-driven 3D hardware concept workbench. You describe a device in natural language, an agent turns that into validated 3D parts (primitive shapes) rendered as a translucent holographic object over the live webcam image, and you select, edit, assemble, explode, and "wear" them with your own hands while the agent keeps helping via a tool loop.

Status: early prototype. Working today: text→3D generation, part editing (manual + AI), exploded view, and a webcam arm-tracking try-on prototype. In progress: the agent tool harness, realtime voice, and a general "attach to body" tool.

The UI is in Traditional Chinese (zh-TW) today; an English UI with a language switch is being built (spec `english-ui`). Every new user-facing string goes into its area's string table (`defineText`, see `shared/i18n/define.ts` and english-ui R53) with both zh-TW and English; when unsure of the English, write plain English, and english-ui reviews the wording later. Existing Chinese strings stay where they are until an english-ui task moves them. Model output stays in Traditional Chinese until english-ui adds the answer-language choice.

Privacy model: the camera image stays in the browser. Hand tracking runs on the user's machine. Model back ends receive only text and model data, never video.
