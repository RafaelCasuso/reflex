/* REFLEX public site: the console (RFX-136).
   The whole site is one screen. Without this script every page is a readable
   document inside the tube; with it, the screen takes commands: `help`
   lists them, the F-keys at the top run the usual ones, typing anywhere
   goes to the prompt. Nothing here makes a request anywhere: no fetch, no
   beacon, no third party. The only thing kept between visits is the
   phosphor colour, in this browser's localStorage. */
(() => {
  "use strict";
  const root = document.documentElement;
  const base = root.dataset.base === "/" ? "" : root.dataset.base || "";
  const screen = document.querySelector(".screen");
  const main = document.getElementById("main");
  const form = document.querySelector("form.console-prompt");
  const input = form ? form.querySelector("input") : null;
  const log = document.getElementById("transcript");
  const lamps = document.querySelectorAll(".lamps li");
  if (!screen || !main || !form || !input || !log) {
    return;
  }
  root.classList.add("js");

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const PHOSPHORS = {
    amber: ["#ffb000", "#d08d14", "rgba(255, 176, 0, 0.42)"],
    green: ["#5ad185", "#2f9a5a", "rgba(90, 209, 133, 0.42)"],
    white: ["#efe6d2", "#a89f8c", "rgba(239, 230, 210, 0.35)"],
    blue: ["#7fd0ff", "#3f8fbf", "rgba(127, 208, 255, 0.4)"],
  };

  /* ---------- output ---------- */

  function line(text, kind) {
    const element = document.createElement("div");
    element.className = kind ? `out ${kind}` : "out";
    element.textContent = text;
    log.appendChild(element);
    return element;
  }
  function lines(list, kind) {
    for (const text of list) {
      line(text, kind);
    }
  }
  function echo(command) {
    const element = document.createElement("div");
    element.className = "out echo";
    const prompt = document.createElement("span");
    prompt.className = "prompt-text";
    prompt.textContent = "operator@reflex:~$ ";
    element.appendChild(prompt);
    element.appendChild(document.createTextNode(command));
    log.appendChild(element);
  }
  function bottom() {
    // A terminal does not animate its scrollback.
    main.scrollTop = main.scrollHeight;
  }

  /* ---------- the sections of this page ---------- */

  function sections() {
    return Array.from(main.querySelectorAll("h1[id], h2[id]")).map(
      (heading) => ({
        id: heading.id,
        title: heading.textContent.trim(),
        element: heading,
      }),
    );
  }
  /* Set when a command moved the view itself; the transcript stays put. */
  let moved = false;
  function jump(id) {
    const target = document.getElementById(id);
    if (!target) {
      return false;
    }
    moved = true;
    target.scrollIntoView({ behavior: "auto", block: "start" });
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
    return true;
  }
  function sizeOf(heading) {
    let bytes = heading.outerHTML.length;
    let node = heading.nextElementSibling;
    while (node && !/^H[12]$/.test(node.tagName)) {
      bytes += node.outerHTML.length;
      node = node.nextElementSibling;
    }
    return bytes;
  }

  /* ---------- lamps and phosphor ---------- */

  function light(verdict) {
    lamps.forEach((lamp) => {
      lamp.classList.toggle("lit", lamp.classList.contains(verdict));
    });
  }
  function phosphor(name, say) {
    const colours = PHOSPHORS[name];
    if (!colours) {
      return false;
    }
    root.style.setProperty("--phosphor", colours[0]);
    root.style.setProperty("--phosphor-dim", colours[1]);
    root.style.setProperty("--glow", colours[2]);
    try {
      localStorage.setItem("reflex-phosphor", name);
    } catch {
      /* a private window keeps nothing; fine */
    }
    if (say) {
      line(
        `phosphor: ${name} (P${{ amber: 3, green: 1, white: 4, blue: 11 }[name]})`,
      );
    }
    return true;
  }
  try {
    const kept = localStorage.getItem("reflex-phosphor");
    if (kept && PHOSPHORS[kept]) {
      phosphor(kept, false);
    }
  } catch {
    /* nothing kept */
  }

  function degauss() {
    if (reduced) {
      line("degauss: skipped, motion is reduced on this machine.");
      return;
    }
    screen.classList.remove("degauss");
    void screen.offsetWidth;
    screen.classList.add("degauss");
    line("degauss: done. The colours were fine; it is just satisfying.");
  }

  /* ---------- the commands ---------- */

  const pages = {
    home: "/",
    install: "/install/",
    plans: "/pricing/",
    pricing: "/pricing/",
    docs: "/docs/",
  };
  function go(path) {
    window.location.href = `${base}${path}`;
  }
  const navigate = (name) => () => {
    line(`opening ${name}...`, "dim");
    go(pages[name]);
  };

  const commands = {
    help: {
      about: "this list",
      run() {
        lines([
          "the console's commands:",
          "  help                 this list",
          "  ls                   the sections of this page, with their size",
          "  open <section>       scroll to a section (tab completes the name)",
          "  home | install | plans | docs   the site's pages",
          "  source | npm         the repository and the packages",
          "  explain              a real decision, as rfx printed it",
          "  allow | ask | deny   light a lamp, and what each verdict means",
          "  phosphor <colour>    amber, green, white or blue",
          "  clear                clear the transcript",
          "",
          "F1 install  F2 plans  F3 docs  F4 help.  Up and down recall history.",
        ]);
      },
    },
    ls: {
      about: "the sections of this page",
      run() {
        const list = sections();
        if (list.length === 0) {
          line("nothing here.");
          return;
        }
        lines(
          list.map(
            (section) =>
              `${String(sizeOf(section.element)).padStart(7)}  ${section.id.padEnd(40)}  ${section.title}`,
          ),
        );
        line(
          `${String(list.length)} section(s). "open <name>" scrolls to one.`,
          "dim",
        );
      },
    },
    open: {
      about: "scroll to a section",
      run(args) {
        const name = args.join("-").toLowerCase();
        if (name === "") {
          line('open what? "ls" lists the sections.');
          return;
        }
        // A section of this page first; then a page of the site.
        const match = sections().find(
          (section) => section.id === name || section.id.startsWith(name),
        );
        if (!match) {
          if (pages[name] !== undefined) {
            navigate(name)();
            return;
          }
          line(`no section called ${name}. "ls" lists them.`);
          return;
        }
        line(`-> ${match.title}`, "dim");
        jump(match.id);
      },
    },
    cat: { about: "same as open", run: (args) => commands.open.run(args) },
    cd: { about: "same as open", run: (args) => commands.open.run(args) },
    home: { about: "the front page", run: navigate("home") },
    install: { about: "the install page", run: navigate("install") },
    plans: { about: "plans and early access", run: navigate("plans") },
    pricing: { about: "plans and early access", run: navigate("pricing") },
    docs: { about: "the documentation", run: navigate("docs") },
    source: {
      about: "the repository",
      run() {
        line("opening github.com/RafaelCasuso/reflex...", "dim");
        window.location.href = "https://github.com/RafaelCasuso/reflex";
      },
    },
    npm: {
      about: "the packages",
      run() {
        line("opening npmjs.com/org/reflex-control...", "dim");
        window.location.href = "https://www.npmjs.com/org/reflex-control";
      },
    },
    explain: {
      about: "a real decision",
      run() {
        const capture = document.querySelector(
          ".terminal[data-capture='explain']",
        );
        if (capture) {
          line(
            "a real session, as rfx printed it (captured by the build, not typed):",
            "dim",
          );
          const copy = capture.cloneNode(true);
          copy.classList.remove("typed");
          log.appendChild(copy);
          light("deny");
        } else {
          line('the capture is on the front page: "home", then "explain".');
        }
      },
    },
    allow: {
      about: "what allow means",
      run() {
        light("allow");
        line("allow: the action runs without a prompt.", "v-allow");
      },
    },
    ask: {
      about: "what ask means",
      run() {
        light("ask");
        line(
          "ask: the host's own permission prompt is used; REFLEX never draws a dialog of its own.",
          "v-ask",
        );
      },
    },
    deny: {
      about: "what deny means",
      run() {
        light("deny");
        line(
          "deny: the action stops before it runs. A human can let it through once, on the record, with rfx override.",
          "v-deny",
        );
      },
    },
    phosphor: {
      about: "the screen's colour",
      run(args) {
        if (!phosphor((args[0] || "").toLowerCase(), true)) {
          line("phosphor amber | green | white | blue");
        }
      },
    },
    theme: {
      about: "same as phosphor",
      run: (args) => commands.phosphor.run(args),
    },
    clear: {
      about: "clear the transcript",
      run() {
        log.replaceChildren();
      },
    },
    /* The console's own jokes. Each one says it is the console's, never a
       decision REFLEX made: the product's verdicts come from policy, and
       this page has none loaded. */
    sudo: {
      hidden: true,
      run(args) {
        const text = args.join(" ");
        if (/rm\s+-rf?\s+\/|mkfs|dd\s+if=/.test(text)) {
          light("deny");
          lines(
            [
              "deny   console-no-destructive                 this console  precedence 1  mandatory  <- decides",
              "Effect       deny",
              "This is the console's own rule, not a REFLEX decision: no policy is loaded on a web page.",
              "On a real machine the same command meets your team's policy, and a human can run: rfx override <decision id>",
            ],
            "v-deny",
          );
          return;
        }
        light("ask");
        line(
          "ask: the console has no root. The host's own prompt would handle it; here, nothing happens.",
          "v-ask",
        );
      },
    },
    rm: { hidden: true, run: (args) => commands.sudo.run(["rm", ...args]) },
    rfx: {
      hidden: true,
      run(args) {
        if (args[0] === "explain") {
          commands.explain.run();
          return;
        }
        lines([
          "this is the website's console, not the command.",
          "the real one:  npm install -g @reflex-control/cli && rfx init",
          '"install" has the whole page.',
        ]);
      },
    },
    whoami: {
      hidden: true,
      run() {
        line(
          "operator. REFLEX never asks who you are; it asks what the action is.",
        );
      },
    },
    uptime: {
      hidden: true,
      run() {
        const since = performance.now() / 1000;
        line(
          `up ${since.toFixed(0)}s on this page, 0 prompts shown, 0 humans interrupted.`,
        );
      },
    },
    date: {
      hidden: true,
      run() {
        const now = new Date();
        line(
          `${now.toISOString()}  (the firmware believes it is 1983; the clock does not)`,
        );
      },
    },
    make: {
      hidden: true,
      run(args) {
        if ((args[0] || "") === "coffee") {
          light("ask");
          line(
            "ask: brewing is an external side effect with a financial consequence. The host's prompt would ask you. The console cannot brew.",
            "v-ask",
          );
          return;
        }
        line(`make: nothing to be done for '${args.join(" ") || "all"}'.`);
      },
    },
    exit: {
      hidden: true,
      run() {
        line(
          "there is no exit from Observe mode. On a real machine: rfx uninstall, and it leaves your files as it found them.",
        );
      },
    },
    pwd: {
      hidden: true,
      run() {
        line(
          "~  (a web page has no working directory, and a claimed project never uploads one either)",
        );
      },
    },
    ping: {
      hidden: true,
      run() {
        line(
          "ping: network ............. none. Nothing leaves this machine; the boot said so.",
        );
      },
    },
    curl: {
      hidden: true,
      run(args) {
        light("ask");
        line(
          `ask: ${args[0] || "that"} is an external side effect. On a real machine the host's prompt would ask you; here the network is none.`,
          "v-ask",
        );
      },
    },
    wget: { hidden: true, run: (args) => commands.curl.run(args) },
    vim: {
      hidden: true,
      run() {
        line(
          "vim: no editor on this terminal, and no way out of one. The record is read-only anyway.",
        );
      },
    },
    emacs: { hidden: true, run: () => commands.vim.run() },
    nano: { hidden: true, run: () => commands.vim.run() },
    hello: {
      hidden: true,
      run() {
        line(
          "hello, operator. Your agents can be trusted with more than you let them do; that is the whole point.",
        );
      },
    },
    hi: { hidden: true, run: () => commands.hello.run() },
    quit: { hidden: true, run: () => commands.exit.run() },
    degauss: { hidden: true, run: degauss },
    about: {
      hidden: true,
      run() {
        lines([
          "REFLEX, the autonomy control layer for AI agents. Apache-2.0.",
          "This console is HTML, CSS and one script from this origin. It sends nothing anywhere.",
          "Faces: VT323 by Peter Hull for the screen, IBM Plex Mono for the docs and the code.",
          "Try: ls, explain, phosphor green, or the sequence every arcade knew.",
        ]);
      },
    },
  };

  /* ---------- the prompt ---------- */

  const history = [];
  let cursor = 0;

  function run(raw) {
    const text = raw.trim();
    moved = false;
    echo(text);
    if (text === "") {
      bottom();
      return;
    }
    history.push(text);
    cursor = history.length;
    const [name, ...args] = text.split(/\s+/);
    const command = commands[name.toLowerCase()];
    if (command) {
      command.run(args);
    } else if (
      sections().some((section) => section.id === name.toLowerCase())
    ) {
      commands.open.run([name]);
    } else {
      line(`${name}: not a command here. "help" lists them.`);
    }
    if (!moved) {
      bottom();
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run(input.value);
    input.value = "";
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      cursor = Math.max(0, cursor - 1);
      input.value = history[cursor] || "";
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      cursor = Math.min(history.length, cursor + 1);
      input.value = history[cursor] || "";
    } else if (event.key === "Tab") {
      const value = input.value;
      const words = value.split(/\s+/);
      const last = words[words.length - 1].toLowerCase();
      const pool =
        words.length > 1
          ? sections().map((section) => section.id)
          : Object.keys(commands).filter((key) => !commands[key].hidden);
      const found = pool.filter((candidate) => candidate.startsWith(last));
      if (found.length === 1) {
        event.preventDefault();
        words[words.length - 1] = found[0];
        input.value = `${words.join(" ")} `;
      } else if (found.length > 1) {
        event.preventDefault();
        line(found.join("  "), "dim");
        bottom();
      }
    }
  });

  /* Typing anywhere on the screen goes to the prompt, unless something else
     is focused on purpose (a link by keyboard, text being selected). */
  document.addEventListener("keydown", (event) => {
    if (
      event.target === input ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return;
    }
    const tag = (event.target && event.target.tagName) || "";
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(tag)) {
      return;
    }
    if (event.key.length === 1 && window.getSelection().toString() === "") {
      input.focus();
    }
  });

  /* The F-keys: the strip's buttons, and the keys themselves. */
  const F = { F1: "install", F2: "plans", F3: "docs", F4: "help" };
  document.addEventListener("keydown", (event) => {
    if (F[event.key] && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      run(F[event.key]);
    }
  });
  document.querySelectorAll("[data-command]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      run(button.dataset.command);
      input.focus();
    });
  });

  /* The sequence every arcade knew. */
  const KONAMI = [
    "ArrowUp",
    "ArrowUp",
    "ArrowDown",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "ArrowLeft",
    "ArrowRight",
    "b",
    "a",
  ];
  let konami = 0;
  document.addEventListener("keydown", (event) => {
    if (event.key === KONAMI[konami]) {
      konami += 1;
      if (konami === KONAMI.length) {
        konami = 0;
        input.value = "";
        echo("↑↑↓↓←→←→BA");
        degauss();
        phosphor("green", true);
        line("30 lives. REFLEX still asks before the dangerous ones.", "dim");
        bottom();
      }
    } else {
      konami = event.key === KONAMI[0] ? 1 : 0;
    }
  });

  /* The boot, once per visit. It prints on a panel of its own over the
     page, which is already laid out underneath; when the panel is removed
     nothing on the page has moved, and the boot lines are copied into the
     scrollback below everything. */
  const booted = (() => {
    try {
      return sessionStorage.getItem("reflex-booted") === "1";
    } catch {
      return true;
    }
  })();
  if (!booted && !reduced) {
    const boot = [
      "REFLEX CONTROL LAYER  ROM 0.2",
      "phosphor ............ ok",
      "policy engine ....... ok  (deterministic first)",
      "verdicts ............ allow  ask  deny",
      "network ............. none  (nothing leaves this machine)",
      "ready. type help.",
    ];
    const panel = document.createElement("div");
    panel.className = "boot";
    panel.setAttribute("aria-hidden", "true");
    main.appendChild(panel);
    boot.forEach((text, index) => {
      window.setTimeout(
        () => {
          const last = index === boot.length - 1;
          const element = document.createElement("div");
          element.className = last ? "out" : "out dim";
          element.textContent = text;
          panel.appendChild(element);
          if (last) {
            panel.remove();
            boot.forEach((kept, position) => {
              line(kept, position === boot.length - 1 ? "" : "dim");
            });
            try {
              sessionStorage.setItem("reflex-booted", "1");
            } catch {
              /* fine */
            }
          }
        },
        120 + index * 160,
      );
    });
  } else {
    line("ready. type help.", "dim");
  }
})();
