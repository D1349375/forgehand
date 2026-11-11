# Prior work (before Kiro)

This repository starts from a prototype built between **2026-11-10 and 2026-11-12** (Asia/Taipei) in a private repository, using **OpenAI Codex CLI** and **Anthropic Claude Code** as coding agents. It was imported here as a single commit. Development from this point on uses Kiro; the `.kiro/` directory and the commit history after the import show that work.

## What the imported prototype contains

| Area | State at import |
|---|---|
| Text → 3D | A description becomes a `ModelSpec` (parts with primitive shapes, dimensions in metres, parent/child hierarchy), validated with Zod on the server and the client, and rendered with Three.js as a translucent holographic object over the webcam image. |
| Model back ends | One `ModelProvider` interface with three adapters: Codex CLI (a long-running `app-server` with per-request isolated threads, or per-request `exec`), Claude Code CLI (`claude -p` with a JSON schema, all tools disabled), and the OpenAI API. |
| Editing | Click/list selection, numeric fields, transform handles, undo/redo, and AI edit plans that return only the changed parts. Real-CLI edit checks: 6/6 for both Codex and Claude; one AI edit took 8–80 s. |
| Exploded view | `src/scene/explode.ts`: a simplified version of Li, Agrawala, Curless and Salesin (SIGGRAPH 2008), using axis-aligned directions and bounding boxes, inner sub-assemblies first. Display state only. |
| Arm tracking | `src/try-on/`: MediaPipe Tasks Vision 1.2.2 hand and pose landmarkers in a web worker, driving a prebuilt cuff on the forearm in a mirrored camera view. This is the first test of what will become a general "attach to body" tool. |

## Arm tracking measurements

All on a 2-core / 8 GB laptop with Intel HD Graphics 620, 640×480 frames, VIDEO mode, median after warm-up:

| Configuration | Hand | Pose |
|---|---|---|
| CPU, two hands + pose (first version) | 552 ms | 208 ms |
| GPU, one hand + pose (imported version) | 34 ms | 27 ms |

The first GPU inference compiles shaders (hand ~10.6 s, pose ~4.4 s), so the worker warms both models while loading.

A 93-second recording of a real session was replayed frame by frame through the real models to find why the cuff jumped. Causes and fixes in the imported version: hard switches between the hand-axis and elbow forearm directions (now blended over 300 ms), handedness label flips (a new side must hold for 6 frames), half-turn roll flips from the palm-facing ambiguity (rejected within 250 ms), and fists dropped because a knuckle was extrapolated just past the frame edge (30% margin allowed). Orientation and on-screen size use the metric world landmarks. On that recording at 30 fps, the cuff is placed in 100% of frames where a hand was found (was 93%, fists 87%), and the 99th-percentile frame-to-frame rotation fell from 150° to 27°.

Known limits at import: startup takes 20–33 s (model download and GPU warm-up), fast motion blur still loses the hand briefly, only one hand is tracked, and the cuff is a fixed stand-in rather than a user's own design.

## Third-party software and models

React, Three.js, Express, Zod, Vite, Vitest, Playwright, dotenv, and MediaPipe Tasks Vision. The MediaPipe hand and pose landmarker models are downloaded at runtime from Google's public model storage. See `package.json` for versions.
