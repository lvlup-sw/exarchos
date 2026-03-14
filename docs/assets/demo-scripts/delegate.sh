#!/bin/bash
sleep 0.4
printf "\n"
printf "\033[1;36m→\033[0m Auto-chaining to \033[1m/exarchos:delegate\033[0m\n"
printf "  \033[2mPhase: plan → delegate\033[0m\n"
printf "\n"
sleep 0.5
printf "  Creating worktrees...\n"
sleep 0.3
printf "\n"
printf "  \033[34m→\033[0m \033[1mSubagent A\033[0m  task 1  \033[2m.claude/worktrees/rate-limit-types\033[0m\n"
sleep 0.2
printf "  \033[34m→\033[0m \033[1mSubagent B\033[0m  task 2  \033[2m.claude/worktrees/sliding-window\033[0m\n"
sleep 0.2
printf "  \033[34m→\033[0m \033[1mSubagent C\033[0m  task 3  \033[2m.claude/worktrees/middleware\033[0m\n"
sleep 0.2
printf "  \033[34m→\033[0m \033[1mSubagent D\033[0m  task 4  \033[2m.claude/worktrees/integration-tests\033[0m\n"
printf "\n"
sleep 0.5
printf "  \033[2mMonitoring 4 subagents...\033[0m\n"
printf "\n"
sleep 0.8
printf "  \033[32m✓\033[0m Subagent A  task 1 complete   \033[2m42s\033[0m\n"
sleep 0.4
printf "  \033[32m✓\033[0m Subagent C  task 3 complete   \033[2m58s\033[0m\n"
sleep 0.4
printf "  \033[32m✓\033[0m Subagent D  task 4 complete   \033[2m1m 12s\033[0m\n"
sleep 0.4
printf "  \033[32m✓\033[0m Subagent B  task 2 complete   \033[2m1m 31s\033[0m\n"
printf "\n"
sleep 0.3
printf "  \033[1;32m✓\033[0m \033[1mAll 4 tasks complete.\033[0m Auto-chaining to /exarchos:review\n"
printf "\n"
