# TODO

# ISSUES: 
- Auto complete on tab even when not relevant
- themes
- would like Enter to replay the previous command, like in gdb
- fuzzy find files
- going to prev with ctrl+p should put sursor at the end
- add gdb features?
- asm is not rendered ideally? maybe add some spacing? gdb make clear distinction between src and func name
- better pane navigation/controls/resizing/etc... i like how herdr does it, but i can't really have that be the same, can I? maybe i can with a diff prefix?
- it would be nice to tag sessions with things like release number, commit, gh issue, etc.
- build tool?
- display in gdb should still display after every step
- closing should clear the output and print session like "resume session with aidb -r session_name_uuid"
- similarly, the sessions/targets without a name should be uuids with the relevant noun before it

# TESTING STRATEGY
- once we get AI integration, the AI will be able to run the debugger and visualize the screen 
  we can enumerate every single feature and what it should look like. then, we can create an ai swarm 
  to try each of the features in random orders (need a graph of dependent features; test both valid graphs and invalid graphs)
  we can try on different OSs with different versions with differenet screen sizes. 
- we can also task the AI to create a certain visualization and check output. 
- the watch windows are nice, but ideally would like to create better output visuzlations.

