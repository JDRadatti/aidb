# TODO

# PLANNING:
- fuzzy find files
- session tags (release number, commit, gh issue, ...)
- build tool?
- whole-memory pane (mem of the program, not one address)
- better pane navigation/controls/resizing (herdr-style? diff prefix?)
- more gdb features?
- named theme presets

# ISSUES:
- themes
- clean up the / prmopt descriptions. instead of saying the args, it should just say the description. also, the session is save [name] where the other nouns are save <name>. 
- still need to cleanup the intro prompt and the help prompt. i like having [] like [sessions] maybe on a new line and then on the next line indented is the first session and hten the next is the next session and so on. i think the intro prompt should just say the sessions targets and lyaouts? also, it should say something about /help for help and /sessing. maybe a /help for a more full description of the api. maybe a list of the debugging commands? 
- would be nice to have [target: targetname] [session: sessionname] [layout: layoutname] in the bottom bar on the right? 
- is the fuzzy finder working? when i do > to open a /open and then i type e, it does not filter just the e things, even though i have two called example
- asm is not rendered ideally? maybe add some spacing? gdb make clear distinction
  between src and func name   [FIXED: ANSI-aware column padding + distinct `function`
  color role (95); interleaved gutters aligned]
- layout watch windows are not saved when canceling and reopening.  [DECIDED:
  no auto-save on layouts — sessions keep referencing named layouts; explicit
  /layout save only]
- display in gdb should still display after every step   [FIXED: `display <expr>` /
  `undisplay <n>` / `info display` backed by the watch pane]
- the commands with args should have a light colored text prompting the arg.
  like /layout save <name> and name is a lighter color   [FIXED: `placeholder`
  role (245) tints <args> in help + slash dropdown; fillKeys no longer mangles
  placeholders into "—"]
- better output visualizations for watch windows
- there should be a mem pane that shows all the mem of the program. instead of
  having to specify a address location

# DONE — PickCaret / ctrl-keys in the fuzzy finder
- every readline ctrl binding now works INSIDE the finder: ctrl+a/e (line
  start/end), ctrl+b/f (char left/right), alt+b/f + ctrl+left/right (word
  moves), ctrl+w/alt+d (kill word back/forward, readline whitespace intake),
  ctrl+u/k (kill to line start/end), ctrl+y (yank the last kill), backspace /
  Delete / ctrl+d delete around the caret. ctrl+d at the TYPED TAIL still
  means item-delete (readline parity: nothing to delete there).
- the block cursor in the real prompt tracks the caret (main.ts setPromptCaret).

# DONE — prompt/band framing (ui.promptZone)
- ui.promptZone: off | line | line+rail (default line: divider only — the
  left rail was dropped per user request; set \"ui\": { \"promptZone\": \"line+rail\" }
  in ~/.aidbrc to bring the rail back, or \"off\" to disable the frame).
- the line above the prompt now sits ABOVE the popups: when a dropdown/picker
  band is composite, a divider in theme.inputBorder tops the band and the
  editor's own top border is suppressed (no stacking; idle look unchanged).
- line+rail adds a left rail `│` in theme.inputBorder on the band rows AND the
  prompt line (editor lays out one column narrower; cursor stays correct).
- the overlay compensates for the suppressed top border (+2 offset while a
  framed band is up: +1 for the border's own row, +1 because the prompt climbs
  into that freed row), so the popup docks flush above the prompt instead of
  landing on it — the prompt stays visible whenever a popup is open.
- theme.inputBorder (default 240) colors the frame; /config reload re-applies
  it live. plan: prompt-band-plan.md.

# TESTING STRATEGY
- once we get AI integration, the AI will be able to run the debugger and visualize the screen 
  we can enumerate every single feature and what it should look like. then, we can create an ai swarm 
  to try each of the features in random orders (need a graph of dependent features; test both valid graphs and invalid graphs)
  we can try on different OSs with different versions with differenet screen sizes. 
- we can also task the AI to create a certain visualization and check output. 
- the watch windows are nice, but ideally would like to create better output visuzlations.

# Finished
- would like Enter to replay the previous command, like in gdb
- closing clears the output and prints "Resume session with: aidb -r <name>" (`-r <name>` = short alias for `--session <name>`)
- unnamed sessions/targets auto-save as noun-prefixed uuids (`session_<uuid>` / `target_<uuid>`, replacing `@<uuid>` / program-basename / "session") so they never collide and are always resume-able
- going to prev with ctrl+p (or ArrowUp) should put cursor at the end
- auto complete on tab should only fire when relevant (run/file paths, path-shaped tokens)

