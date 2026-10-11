/* REFLEX public site: the console (RFX-136).
   The whole site is one screen. Without this script every page is a readable
   document on the tube; with it, the screen takes commands. What the prompt
   takes is never a secret: a menu under the page lists the commands as you
   type, with what each one does and the arguments it accepts; Tab completes,
   the key bar at the foot names the keys, and `help` prints the same list.
   Output lands in a drawer above the prompt, so it is seen wherever the page
   is scrolled. Nothing here makes a request anywhere: no fetch, no beacon,
   no third party. The only thing kept between visits is the phosphor colour,
   in this browser's localStorage. */
(() => {
  "use strict";
  const root = document.documentElement;
  const base = root.dataset.base === "/" ? "" : root.dataset.base || "";
  const screen = document.querySelector(".screen");
  const main = document.getElementById("main");
  const form = document.querySelector("form.console-prompt");
  const input = form ? form.querySelector("input") : null;
  const log = document.getElementById("transcript");
  const menu = document.getElementById("menu");
  const lamps = document.querySelectorAll(".lamps li");
  if (!screen || !main || !form || !input || !log || !menu) {
    return;
  }
  root.classList.add("js");

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  /* phosphor, its dim, its glow, the bright white of emphasis, the ink of
     the readable face. Green is the default (site.css carries the same). */
  const PHOSPHORS = {
    green: [
      "#5ad185",
      "#2f9a5a",
      "rgba(90, 209, 133, 0.42)",
      "#eafbe9",
      "#dfead9",
    ],
    amber: [
      "#ffb000",
      "#d08d14",
      "rgba(255, 176, 0, 0.42)",
      "#fff3d6",
      "#f1e3c3",
    ],
    white: [
      "#efe6d2",
      "#a89f8c",
      "rgba(239, 230, 210, 0.35)",
      "#ffffff",
      "#f2efe8",
    ],
    blue: [
      "#7fd0ff",
      "#3f8fbf",
      "rgba(127, 208, 255, 0.4)",
      "#e6f4ff",
      "#dbe9f3",
    ],
  };
  const PHOSPHOR_NUMBERS = {
    green: "P1",
    amber: "P3",
    white: "P4",
    blue: "P11",
  };
  const DEFAULT_PHOSPHOR = "green";

  /* ---------- output: the drawer above the prompt ---------- */

  function line(text, kind) {
    const element = document.createElement("div");
    element.className = kind ? `out ${kind}` : "out";
    element.textContent = text;
    log.appendChild(element);
    log.hidden = false;
    noteOutput();
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
    log.hidden = false;
    noteOutput();
  }
  function bottom() {
    // A terminal does not animate its scrollback.
    log.scrollTop = log.scrollHeight;
  }
  function closeDrawer() {
    log.hidden = true;
  }
  /* Reading the page is a way of saying "enough": once the page has been
     scrolled a screen's worth since the last output, the drawer gets out of
     the way. The next output brings it back. */
  let scrolledAtOutput = 0;
  function noteOutput() {
    scrolledAtOutput = main.scrollTop;
  }
  main.addEventListener("scroll", () => {
    if (!log.hidden && Math.abs(main.scrollTop - scrolledAtOutput) > 240) {
      closeDrawer();
    }
  });

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
  function jump(id) {
    const target = document.getElementById(id);
    if (!target) {
      return false;
    }
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
    root.style.setProperty("--focus", colours[3]);
    root.style.setProperty("--ink", colours[4]);
    try {
      localStorage.setItem("reflex-phosphor", name);
    } catch {
      /* a private window keeps nothing; fine */
    }
    if (say) {
      line(`phosphor: ${name} (${PHOSPHOR_NUMBERS[name]})`);
    }
    return true;
  }
  function current() {
    try {
      const kept = localStorage.getItem("reflex-phosphor");
      return kept && PHOSPHORS[kept] ? kept : DEFAULT_PHOSPHOR;
    } catch {
      return DEFAULT_PHOSPHOR;
    }
  }
  if (current() !== DEFAULT_PHOSPHOR) {
    phosphor(current(), false);
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

  /* What a command takes after its name, for the menu and for Tab. */
  const sectionChoices = () =>
    sections().map((section) => [section.id, section.title]);
  const colourChoices = () =>
    Object.keys(PHOSPHORS).map((name) => [
      name,
      `${PHOSPHOR_NUMBERS[name]} phosphor`,
    ]);

  const commands = {
    help: {
      about: "this list, printed",
      run() {
        lines([
          "the console's commands:",
          "  help                 this list",
          "  ls                   the sections of this page, with their size",
          "  open <section>       scroll to a section (Tab completes the name)",
          "  home | install | plans | docs   the site's pages",
          "  source | npm         the repository and the packages",
          "  explain              a real decision, as rfx printed it",
          "  allow | ask | deny   light a lamp, and what each verdict means",
          "  phosphor <colour>    green, amber, white or blue",
          "  clear                clear the transcript",
          "",
          "The menu under the page shows the same as you type; Tab completes,",
          "Up and Down recall history, Esc closes. F1 install, F2 plans, F3 docs, F4 help.",
          "A few commands are not on the list. The manual of 1983 did not list them either.",
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
      about: "scroll to a section of this page",
      takes: sectionChoices,
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
    cat: {
      about: "same as open",
      alias: true,
      takes: sectionChoices,
      run: (args) => commands.open.run(args),
    },
    cd: {
      about: "same as open",
      alias: true,
      takes: sectionChoices,
      run: (args) => commands.open.run(args),
    },
    home: { about: "the front page", run: navigate("home") },
    install: {
      about: "the install page: one command, two minutes",
      run: navigate("install"),
    },
    plans: { about: "plans and early access", run: navigate("plans") },
    pricing: { about: "same as plans", alias: true, run: navigate("pricing") },
    docs: { about: "the documentation", run: navigate("docs") },
    source: {
      about: "the repository on GitHub",
      run() {
        line("opening github.com/RafaelCasuso/reflex...", "dim");
        window.location.href = "https://github.com/RafaelCasuso/reflex";
      },
    },
    npm: {
      about: "the packages on npm",
      run() {
        line("opening npmjs.com/org/reflex-control...", "dim");
        window.location.href = "https://www.npmjs.com/org/reflex-control";
      },
    },
    explain: {
      about: "a real decision, as rfx printed it",
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
      about: "what allow means (and light the lamp)",
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
      takes: colourChoices,
      run(args) {
        if (!phosphor((args[0] || "").toLowerCase(), true)) {
          line("phosphor green | amber | white | blue");
        }
      },
    },
    theme: {
      about: "same as phosphor",
      alias: true,
      takes: colourChoices,
      run: (args) => commands.phosphor.run(args),
    },
    clear: {
      about: "clear the transcript",
      run() {
        log.replaceChildren();
        closeDrawer();
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
          "Try: ls, explain, phosphor amber, or the sequence every arcade knew.",
        ]);
      },
    },
  };

  /* ---------- the menu: what the prompt takes, as you type ---------- */

  function listed() {
    return Object.keys(commands).filter(
      (key) => !commands[key].hidden && !commands[key].alias,
    );
  }
  /* The choices for what is typed so far: commands by prefix, or, after a
     command that takes something, its arguments by prefix. */
  function suggestions(value) {
    const words = value.replace(/^\s+/, "").split(/\s+/);
    const first = (words[0] || "").toLowerCase();
    if (words.length === 1) {
      return listed()
        .filter((key) => key.startsWith(first))
        .map((key) => ({
          value: key,
          label: key,
          about: commands[key].about,
          more: Boolean(commands[key].takes),
        }));
    }
    const command = commands[first];
    if (!command || !command.takes) {
      return [];
    }
    const typed = words.slice(1).join(" ").toLowerCase();
    return command
      .takes()
      .filter(([id]) => id.startsWith(typed))
      .map(([id, title]) => ({
        value: `${first} ${id}`,
        label: id,
        about: title,
        more: false,
      }));
  }
  function showMenu() {
    const items = suggestions(input.value);
    menu.replaceChildren();
    if (items.length === 0) {
      menu.hidden = true;
      return;
    }
    for (const item of items) {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.className = "choice";
      choice.dataset.value = item.value;
      if (item.more) {
        choice.dataset.more = "1";
      }
      const name = document.createElement("b");
      name.textContent = item.more ? `${item.label} …` : item.label;
      const about = document.createElement("span");
      about.textContent = item.about;
      choice.append(name, about);
      menu.appendChild(choice);
    }
    if (input.value.trim() === "") {
      const tail = document.createElement("p");
      tail.className = "more";
      tail.textContent = "…and a few the manual does not list.";
      menu.appendChild(tail);
    }
    menu.hidden = false;
  }
  function hideMenu() {
    menu.hidden = true;
  }
  /* Tab: one match completes; several complete what they share. */
  function complete() {
    const items = suggestions(input.value);
    if (items.length === 0) {
      return;
    }
    let shared = items[0].value;
    for (const item of items) {
      while (!item.value.startsWith(shared)) {
        shared = shared.slice(0, -1);
      }
    }
    input.value = items.length === 1 ? `${shared} ` : shared;
    showMenu();
  }
  input.addEventListener("focus", showMenu);
  input.addEventListener("click", showMenu);
  input.addEventListener("input", showMenu);
  // A narrow screen has no room for the long invitation.
  if (window.matchMedia("(max-width: 44rem)").matches) {
    input.placeholder = "a command, or ?";
  }
  // A press on a choice must not take the focus from the prompt.
  menu.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  menu.addEventListener("click", (event) => {
    const choice = event.target.closest("button.choice");
    if (!choice) {
      return;
    }
    if (choice.dataset.more) {
      input.value = `${choice.dataset.value} `;
      showMenu();
    } else {
      input.value = "";
      hideMenu();
      run(choice.dataset.value);
    }
    input.focus();
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".menu, .console-prompt")) {
      hideMenu();
    }
  });

  /* ---------- the prompt ---------- */

  const history = [];
  let cursor = 0;

  function run(raw) {
    const text = raw.trim();
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
      line(
        `${name}: not a command here. The menu under the page lists them; so does "help".`,
      );
    }
    bottom();
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    hideMenu();
    run(input.value);
    input.value = "";
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      cursor = Math.max(0, cursor - 1);
      input.value = history[cursor] || "";
      showMenu();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      cursor = Math.min(history.length, cursor + 1);
      input.value = history[cursor] || "";
      showMenu();
    } else if (event.key === "Tab" && !event.shiftKey) {
      if (suggestions(input.value).length > 0) {
        event.preventDefault();
        complete();
      }
    } else if (event.key === "Escape") {
      if (!menu.hidden) {
        hideMenu();
      } else if (!log.hidden) {
        closeDrawer();
      } else {
        input.value = "";
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

  /* The F-keys: the key bar, the strip's links, and the keys themselves. */
  const F = { F1: "install", F2: "plans", F3: "docs", F4: "help" };
  document.addEventListener("keydown", (event) => {
    if (F[event.key] && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      hideMenu();
      run(F[event.key]);
    }
  });
  document.querySelectorAll("[data-command]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      hideMenu();
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
        hideMenu();
        echo("↑↑↓↓←→←→BA");
        degauss();
        // The other classic tube: amber if the screen is green, green if not.
        phosphor(current() === "green" ? "amber" : DEFAULT_PHOSPHOR, true);
        line("30 lives. REFLEX still asks before the dangerous ones.", "dim");
        bottom();
      }
    } else {
      konami = event.key === KONAMI[0] ? 1 : 0;
    }
  });

  /* The boot, once per visit. It prints on a panel of its own over the
     page, which is already laid out underneath; when the panel is removed
     nothing on the page has moved. The drawer stays closed until there is
     output: the prompt's own placeholder says what to do. */
  const booted = (() => {
    try {
      return sessionStorage.getItem("reflex-booted") === "1";
    } catch {
      return true;
    }
  })();
  const READY = "ready. type a command, or ? for the list.";
  if (!booted && !reduced) {
    const boot = [
      "REFLEX CONTROL LAYER  ROM 0.2",
      "phosphor ............ ok",
      "policy engine ....... ok  (deterministic first)",
      "verdicts ............ allow  ask  deny",
      "network ............. none  (nothing leaves this machine)",
      READY,
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
  }
})();
