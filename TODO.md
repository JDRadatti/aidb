# TODO

# ISSUES: 
- themes
- fuzzy find files
- ctrl+ commands for prompt, like ctrl+u do not work when fuzzy finder is open
- add gdb features?
- asm is not rendered ideally? maybe add some spacing? gdb make clear distinction between src and func name
- better pane navigation/controls/resizing/etc... i like how herdr does it, but i can't really have that be the same, can I? maybe i can with a diff prefix?
- it would be nice to tag sessions with things like release number, commit, gh issue, etc.
- build tool?
- display in gdb should still display after every step
- layout watch windows are not saved. when canceling app and reopening, the source panes should reain the source panes. 
- the commands with args should have a light colored text prompting teh arg. like /layout save <name> and name is a lighter color 
- the prompt input + fuzzy + popup area should be a different color so it is more visible
- there should be a mem pane that shows all the mem of the program. instead of having to specify a address loacation

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

