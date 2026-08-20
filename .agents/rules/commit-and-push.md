# Git Workflow Rule: Commit and Push

## Rule
Whenever completing any set of code changes, fixes, refactorings, or updates:
1. Verify changes by running tests (`cmd /c npm run test:run`) and build (`cmd /c npm run build:all`).
2. Stage all modified and new files (`git add .`).
3. Commit with a concise, descriptive conventional-commit message (`git commit -m "..."`).
4. Push immediately to the active remote branch (`git push origin <branch>`).
5. Never leave uncommitted or unpushed changes at the end of a task turn.
