The failures in {clustersFile} are clustered by exact message (numbers normalized), each cluster across every test that printed it. Turn them into work groups: one group per distinct problem, which one agent fixes with one patch, so that no two agents end up fixing the same thing.

- One test's failures in the same tasks (compare `taskIds`) are usually one problem: its first failure causes the rest. The several "leaked … until shutdown" lines one leak prints (windows at different URLs, docShells…) are one group for that test.
- Different tests share a group only when the same specific failure clearly has one cause (the same assertion from shared code, the same stack). A generic message ("Test timed out", a leaked browser.xhtml window) is never a shared cause on its own.
- One test failing in different ways (a crash on Windows, a leak on macOS) is separate groups.
- Every failure, a test in a cluster, goes in exactly one group: never list a test's failure in two groups.

When the messages don't tell, look at the failed jobs: their logs under {logsDir}/<task id>/ when present, or `fx-tests task <task id>`. Give a one-line reason for each group ("unchanged" when a cluster is kept as is).
