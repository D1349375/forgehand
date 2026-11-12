# Forgehand

Forgehand is a voice- and hand-driven 3D hardware concept workbench. You describe a device in natural language, an agent turns that into validated 3D parts (primitive shapes) rendered as a translucent holographic object over the live webcam image, and you select, edit, assemble, explode, and "wear" them with your own hands while the agent keeps helping via a tool loop.

Status: early prototype. Working today: text→3D generation, part editing (manual + AI), exploded view, and a webcam arm-tracking try-on prototype. In progress: the agent tool harness, realtime voice, and a general "attach to body" tool.

The UI is in Traditional Chinese (zh-TW); an English UI is planned. All user-facing strings in code and model output should be written in Traditional Chinese.

Privacy model: the camera image stays in the browser. Hand tracking runs on the user's machine. Model back ends receive only text and model data, never video.
