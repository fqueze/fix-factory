We have been producing stacks of patches to fix test issues, using skills that organize the work, with a parent agent delegating to subagents, and then trying to organize the result. I worked kinda OK but was very expensive in tokens, and resulted in poor status information, and difficult to handle stacks of patches when trying to get them through review.

At this point we know we can produce good patches, and we've produced 30-50 a week. We need to find ways to scale this effort to be in a position to land at least 50 patches a day (and more later). So every step of the process needs to be more reliable, less effort for human reviewers, and cheaper.

I think the way we should change the workflow is similar to what happened in car factories a century ago. Instead of having a few cars produced a day by very skilled workers (think Opus agents here), the work needing humans was broken down into much smaller pieces of work that required less skilled humans (think Sonnet of Haiku) with very little context about the overall work being down (think having many agents running with very little context to do small tasks). Over the years, more and more of the work got automated using machines instead of humans. I think we should do the same, using scripts for tasks that can be automated without any intelligence, which will make the output more consistent.

Similar to how a car factory director would have an overview of what was happening in the entire factory, I would like to have a web UI that would give me an overview of the status of the ongoing work.

There will be several requests given (by myself) in the input (eg. fix failures of this try push, do a flakiness burndown in <folder>) with a little bit of plain text instructions going with them. Then the work should be broken down.

I want observability at every step. For every task we did, I want to have a way to see how long it took, and what the cost was. I want to be able to click to see profiles (look at the claude-profiler repository).

When a stack of patches is ready for my review before submitting, I want to do one click to have a tab that opens and shows me what `stack-viewer` (from the md-viewer repository) shows me, and let me add review comments quickly.

When the patches have already been submitted, I want to see at a glance the status of every patch of the stack (which are accepted ready to land, which are accepted with comments, which have requests for changes).
When we are replying to reviewers, I want to see the interdiff and the draft replies very easily.

If for some of the patches we have in our stack, we need to file a bug before we can submit them, I want the patch to be listed the same way as the others but instead of "Bug 123456" being a link on the beginning of the line, "Bug to file" and clicking that should open the prefilled form.

Ideally the web UI should be usable also from a smartphone, as the machines running it will be connected to tailscale, and looking at the web UI from whatever device is closest to me to see the status might be useful.

I would like the code of our web UI to be reliable, so I think it should be written in typescript with correct test coverage.

Before you start writing any code, the first task will be to breakdown the entire workflow into small steps, and decide for which one you want to write scripts handling them, for which one you'll start a low end agent, and which ones require high end agents.
I will no longer be running agents from my terminal, they will be started automatically by the node js script, and all the interaction will happen from the web page.
Agents won't be creating worktrees, building or running tests. The orchestrating script will, and will give the agent the result, or start another agent if the result means a next step can start.
The orchestrating script needs to handle the resource of the machine, so the memory and cores of the machine are used continously, but never overloaded. 
  
The workflow needs to go all the way from analysis of my initial prompt, to submitting patches for review (after they've been verified on try, then self-reviewed), addressing review comments, reordering patches for landing, re-submitting through moz-phab (never run moz-phab automatically, but you can make running it one click from the web UI instead of me needing to open a terminal).

Create an md file with the list of tasks and how you'll handle them. You can also create a mockup html page showing me what you think the overview web UI could look like (don't make it work yet, just show what it would look like using artificial data, or data from the stacks of patches we worked on recently).

Feel free to look at the transcripts of recent sessions that happened in /build/firefox to see what we were doing.
  