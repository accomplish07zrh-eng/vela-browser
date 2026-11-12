<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
    <img src="docs/assets/banner-light.svg" alt="Vela Browser, a local-first anti-detect browser. One wall of browsers running at once, each with its own pointer." width="100%">
  </picture>
</p>

<p align="center">
  <a href="README.md">中文</a>&nbsp;&nbsp;·&nbsp;&nbsp;<b>English</b>
</p>

<p align="center">
  <a href="https://github.com/accomplish07zrh-eng/vela-browser/releases">Set sail</a>
  &nbsp;·&nbsp;
  <a href="#wall">The wall</a>
  &nbsp;·&nbsp;
  <a href="#cooling">Lights out</a>
  &nbsp;·&nbsp;
  <a href="#agents">Three pairs of hands</a>
  &nbsp;·&nbsp;
  <a href="#plugins">Tools</a>
  &nbsp;·&nbsp;
  <a href="#build">Shipbuilding</a>
</p>

<br>

<p align="center"><i>
One window, one lamp.<br>
The people beneath them never meet,<br>
and never need to.
</i></p>

<p align="center"><sub>VELA　Latin for “sails”, and a constellation of the southern sky</sub></p>

<br>

## Prologue

<p align="center">
You keep many windows.<br>
Behind each one lives a whole person:<br>
a fingerprint like the rings of a tree,<br>
a way home that comes and goes like the tide,<br>
cookies like a letter left half-written in a drawer.
</p>

<p align="center">
They never call on one another.<br>
Each lights a lamp behind its own wall,<br>
and each goes to sleep.
</p>

<p align="center">· · ·</p>

<p align="center">
And the wall hangs above your own desk.<br>
No account, no cloud,<br>
no one far away keeping your keys.
</p>

<br>

<a name="wall"></a>

## I　The Wall

<p align="center"><sub>一面墙</sub></p>

<p align="center"><i>
One group is one row, and one row is a river.<br>
Neighbouring rivers run against each other,<br>
lamps on either bank, looking across the water.
</i></p>

Slower, and slower still,\
like a night train passing another on the opposite track,\
one lit window after another sliding by.

　　Then you double-click one of them.

It comes toward you,\
and the world narrows to a single frame:\
you can click, write, scroll it page by page,\
no different from a real window.

You set down a word in one window,\
and the others set it down too: one voice leads, the choir answers,\
ripples opening in the same instant.

<details>
<summary><b>Under the lamp</b></summary>
<br>

- **Work in place**: double-click any tile on the wall to enlarge it, then click, type and scroll inside it as in a real window.
- **Sync**: make one environment the leader and the others follow its clicks and keystrokes. The ripples that open together in the banner's top row are this.
- **Groups**: each group is a row; rows can loop end to end, and neighbouring rows drift in opposite directions. Show a single row, or give it more of the wall.
- **Quiet**: on Windows, environment windows can stay out of the taskbar. Only the taskbar button goes; the window, and everything a page can read, stay the same.
- **The dock**: navigation lives in a floating dock at the bottom; other pages rise from below, and <kbd>Esc</kbd> returns to the wall. Paper white by day, a dark theme by night.

</details>

<br>

## II　A Thousand Roads

<p align="center"><sub>千种来路</sub></p>

<p align="center"><i>
One computer, a thousand roads.
</i></p>

Someone comes in out of the Tokyo rain, someone out of the Berlin snow;\
one speaks only English, one answers in the soft vowels of Suzhou.

How wide the screen, how many fonts in the drawer,\
which voice hides in the sound card,\
what colour of dust settles on the graphics card:\
all of it written under their own name,\
from the first time they open their eyes to the last, never a stroke changed.

　　They leave the house by their own road only,\
　　　　and so does anyone who runs an errand for them.

Close the door, and the letter lies where it was.\
Open it again, and the ink is still wet.

<details>
<summary><b>Under the lamp</b></summary>
<br>

- **Engines**: Vela Chromium 155, CloakBrowser or Vela Firefox, chosen per environment; WebKit is experimental.
- **Fingerprints**: screen, fonts, voices, media devices, WebGL, WebRTC and more are generated per environment and stay the same for its whole life.
- **Proxies**: each environment has its own HTTP, HTTPS or SOCKS5 proxy, which can be tested. Every request the environment sends out, including those an AI or a plugin sends for it, goes through that proxy alone.
- **Sessions**: cookies and local storage are saved on close and restored as they were on the next open.
- **In bulk**: groups, import and export, a trash bin and scheduled tasks.

</details>

<br>

<a name="cooling"></a>

## III　Lights Out, Not Gone

<p align="center"><sub>熄灯，不散场</sub></p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/cooling-dark.svg">
    <img src="docs/assets/cooling-light.svg" alt="Memory use rises past the threshold; the browser left alone the longest cools and goes dark, and memory falls. Later a double-click wakes it." width="100%">
  </picture>
</p>

<p align="center"><i>
The night grows late.<br>
The window left alone the longest is the first to go dark.
</i></p>

It is not a goodbye.

The letter is folded into the drawer;\
the key waits under the flowerpot by the door.\
The room still hangs on the wall, only dim,\
a small frost-flower on the glass.

　　The water level falls,\
　　　　and the whole computer lets out a breath.

<p align="center"><i>
When you come back,<br>
the tea is still warm,<br>
the book still open at the page.
</i></p>

<details>
<summary><b>Under the lamp</b></summary>
<br>

- **When**: once system memory use stays above the threshold, Vela picks the browser that has been idle the longest and closes it the way the Close button does, saving its session first, and hands the memory back to the system.
- **Still on the wall**: it does not leave the workbench; it dims and is marked as cooled. Wake it, or double-click it, and its sign-ins and tabs are all there.
- **Never cooled**: the browser you are using, one a script or an AI is driving, and one touched a moment ago.
- **Your line**: by default cooling starts at 85% memory use for browsers idle 10 minutes. Both can be changed in Settings, or cooling switched off.

</details>

<br>

<a name="agents"></a>

## IV　One Thought, Three Pairs of Hands

<p align="center"><sub>一个念头，三双手</sub></p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/agents-dark.svg">
    <img src="docs/assets/agents-light.svg" alt="One AI connected to three browser windows at once; each window has its own pointer, clicking and typing to its own rhythm." width="100%">
  </picture>
</p>

<p align="center"><i>
One thought, three pairs of hands.<br>
Each writes in its own hand,<br>
none reaching for another's pen.
</i></p>

The pointer walks the way a person does:

setting off, a little unsure,\
　　gathering speed along the way,\
　　　　sometimes going too far,\
　　　　　　turning back, and coming to rest.

And it types the way a person does:\
one key,　one key,\
pausing at a comma to think.

<p align="center">· · ·</p>

Heavy rain outside.\
In three windows, three mice are writing letters at once,\
and the one on your desk does not move.

It sees the dark river under F12 as well:\
the murmur of the console, letters going back and forth across the network,\
telegrams that never stop on the WebSocket.

　　But at every door, it knocks first.

<details>
<summary><b>Under the lamp</b></summary>
<br>

- **Connect**: Vela ships an MCP server. Once Claude Code, Cursor or another AI tool connects, it can create environments, open browsers and work in web pages.
- **Human-like input**: the pointer follows eased curves, sometimes overshooting a long move and correcting, and lands somewhere inside the element rather than its centre; it scrolls with the wheel when needed; text is typed key by key at an uneven rhythm, pausing after punctuation. Each environment keeps its own speed and habits, different from every other. `aliasmode_humanize` turns this off or changes the speed.
- **A pointer per window**: every browser window has its own pointer and keyboard. An AI can work many windows at once without them getting in each other's way, and never moves the mouse on your computer.
- **Developer tools**: read the console and exception stacks, network requests and raw responses, WebSocket frames, DOM and styles, cookies and site storage. Run JavaScript, change storage, and send requests through the environment's own network. Send native CDP commands on Chromium. In all three engines the tools attach to the environment's existing context, and its isolation, proxy and fingerprint stay as they were.
- **Asking first**: read-only tools and tools that change things are marked apart, so an AI client can ask you before calling the latter. Reading cookies returns only those the current page would send unless the whole environment is asked for.
- **Scripts**: a local HTTP API in the style of AdsPower's `/api/v1` starts environments from scripts, for Playwright or Puppeteer to connect to. JavaScript scripts can read the console and network record of their run with `devtools.call(...)`.

</details>

<br>

<a name="plugins"></a>

## V　Tools That Fit the Hand

<p align="center"><sub>趁手的工具</sub></p>

<p align="center"><i>
For someone setting out on a long road:<br>
a small knife, a coil of rope, a lantern.
</i></p>

Put a folder in `plugins`,\
one manifest and a little code,\
and the AI learns one more craft:

```js
// plugins/page-info/index.mjs
export default function setup(vela) {
  return {
    async summary() {
      const page = vela.page();
      const errors = await vela.devtools("console", { level: "error" });
      return { title: await page.title(), errors: errors.records.length };
    },
  };
}
```

It works only in the window it stands in now,\
with that room's key, along that room's road.\
It cannot close the window, and cannot climb into the next.

　　Chromium, Firefox, WebKit:\
　　　　three kinds of lamp, the same small knife.

<details>
<summary><b>Under the lamp</b></summary>
<br>

- **Where**: `plugins/<plugin-id>/` in Vela's data folder holds a `vela-plugin.json` manifest and a JavaScript module whose `setup(vela)` returns one function per tool. For the example above the AI sees a tool named `plugin_page_info_summary`.
- **How it runs**: in the environment the AI has selected, with that environment's own context, sign-ins, proxy and fingerprint. A plugin cannot close the browser, and its state never crosses into another environment.
- **Settings**: **Settings → Advanced → Plugins** lists every plugin and its tools, switches each on or off, opens the plugins folder, and can add a working example.
- **Writing one**: see [`docs/plugins.md`](docs/plugins.md). Plugins are code that runs on your computer, so install only ones you trust.

</details>

<br>

## VI　Setting Sail

<p align="center"><sub>启航</sub></p>

<p align="center"><i>
The sail is up.<br>
Let the wind come from where it will.
</i></p>

Windows: download the installer from [Releases](https://github.com/accomplish07zrh-eng/vela-browser/releases).

macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/accomplish07zrh-eng/vela-browser/main/scripts/install-macos.sh | bash
```

Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/accomplish07zrh-eng/vela-browser/main/scripts/install-linux.sh | bash
```

<p align="center"><sub>In-app updates carry their own signature and accept only versions released from this repository.</sub></p>

<br>

<a name="build"></a>

## VII　Shipbuilding

<p align="center"><sub>造船</sub></p>

<p align="center"><i>
To build a boat with your own hands,<br>
first gather the timber and the nails.
</i></p>

You need [Bun](https://bun.sh) 1.4.1 or later; the desktop build also needs Rust and the [Tauri](https://tauri.app) dependencies.

```bash
bun install
bun test
bun start
```

Package the Windows desktop app:

```bash
bun run desktop:prepare
bun run desktop:build:nsis
```

<p align="center"><sub>The moving pictures on this page come from <code>python scripts/make-readme-art.py</code>.<br>If your system asks for reduced motion, they stand quietly still.</sub></p>

<details>
<summary><b>What is on board</b></summary>
<br>

| Where | What |
| --- | --- |
| `src/` | Environments, launcher, fingerprints, proxies, cooling, plugin manifests and the local server |
| `web/` | The interface: the wall, the dock and every page |
| `src-tauri/` | Desktop shell, installer and in-app updates |
| `agent/` | MCP server, developer tools, plugin host, human-like input, script runners |
| `scripts/` | Packaging, installers, acceptance runs and the README art |
| `docs/` | Plugins and developer tools, and the public local API and MCP tool references |
| `*.mjs` at the root | Browser worker processes; packaged next to `agent/`, so they stay at the root |

</details>

<br>

## Afterword

<p align="center"><i>
This boat's keel came from another boat.
</i></p>

Vela Browser is an independent fork of [AliasMode](https://github.com/aliasmode/aliasmode), and is not affiliated with or endorsed by the upstream project or its maintainers.

- Application code remains under the Apache License 2.0; the original code is copyright Xreacher.
- The AliasMode Firefox engine is under MPL-2.0, and the AliasMode Chromium engine under GPL-3.0.
- CloakBrowser is a third-party engine under its own terms.
- Copyright and licences for fonts, voices, media-device data and other third-party resources are listed in [`NOTICE`](NOTICE).

<br>

<p align="center">· · ·</p>
