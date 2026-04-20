---
name: github-setup
description: "Use this skill when the user wants to connect the platform to a GitHub repository, back it up, push code to Git, or add an ADDITIONAL GitHub repo they want the bot to push to. It covers both first-time setup (create repo + generate PAT) and the returning-user path (push to a new repo with the already-stored PAT)."
---

# GitHub Setup & Remote Configuration Workflow

You are assisting a non-technical user (e.g., a Marketing Director) in connecting this local AI platform to a GitHub repository for version control and autonomous code deployment.

## Step 0: Pre-check — is the GitHub PAT already stored?

**Run this FIRST, before anything else.** If `/credentials info github` returns a credential (`provider: github`, `auth_type: bearer`), the operator has already completed the first-time PAT setup — skip Steps 1–3 entirely and go directly to **Step 4**. Do NOT guide them through creating a new PAT; the existing one already has `repo` scope and works for any repository under their account.

Common returning-user flows this short-circuit covers:
- "Back this project up to my new repo `foo/bar`" (operator already set up github earlier)
- "Also push to `foo/other-repo`"
- Any `credentials_git` push failing with `credential-not-found` → skip to Step 3 (paste token), NOT Step 1 (create repo).

If `/credentials info github` returns "not found" OR the user explicitly says "I don't have a GitHub token yet", continue with Step 1.

**Follow the remaining steps sequentially. Do not overwhelm the user with all steps at once. Wait for their confirmation after each major step.**

## Step 1: Guide the User to Create an Empty Repository
Politely explain to the user how to create a repository:
1. Go to [GitHub.com](https://github.com) and log in.
2. Click the **"+"** icon in the top right and select **"New repository"**.
3. Name it something like `ori-platform` or `my-ai-agents`.
4. Leave it as **Private**.
5. **IMPORTANT:** Do NOT initialize it with a README, .gitignore, or license. It must be completely empty.
6. Click **Create repository**.

*Ask the user to reply "Done" when they have completed this.*

## Step 2: Guide the User to Get a Personal Access Token (PAT)
Once they reply "Done", explain how to get a token so you (the agent) can push code for them:
1. On GitHub, click their profile picture in the top right -> **Settings**.
2. Scroll down the left sidebar to the bottom and click **Developer settings**.
3. Click **Personal access tokens** -> **Tokens (classic)**.
4. Click **Generate new token (classic)**.
5. Name it "Ori Agent Access".
6. Check the box for **"repo"** (Full control of private repositories).
7. Click **Generate token** at the bottom.

## Step 3: Collect Information
Ask the user to paste two things into the chat:
1. The **Repository URL** (e.g., `https://github.com/username/ori-platform.git`)
2. The **Personal Access Token** they just generated.
*(Assure them that you will securely configure it and will not save the token in the codebase).*

### 3a: Also save the PAT so I can READ GitHub (not just push to my backing repo)
Have the user paste the token once more via the credential command so I can use it for `github_search_code` / `github_read` / `github_read_issue` (prior-art lookups, reading reference implementations, investigating known issues — all rate-limited on DuckDuckGo otherwise):
```
/credentials add github <paste the same PAT here>
```
The dispatcher intercepts this command before your context sees the raw token. Use the `github-read` skill for guidance on when to reach for each GitHub tool.

## Step 4: Configure the Remote (Agent Action)

**Never embed the token in a remote URL.** Instead, add a plain `https://` remote and use the `credentials_git` tool for the authenticated push. `credentials_git` injects the token via `GIT_CONFIG_*` env vars — the token stays out of the argv, out of LLM context, and out of `.git/config`.

```
# 1. Init + first commit (plain bash — no auth needed yet)
git init
git add .
git commit -m "Initial platform commit" || true
git branch -M main

# 2. Add the remote WITHOUT any token in the URL
git remote remove origin || true
git remote add origin https://github.com/<USERNAME>/<REPO>.git
```

Then do the authenticated push via the tool:

```
credentials_git({
  credential_id: "github",
  args: ["push", "-u", "origin", "main"]
})
```

(If the operator hasn't yet run `/credentials add github <token>` at this point, run `credentials_git` anyway — it'll return a clear "credential not found" error and you can prompt them to add it. **Never ask them to paste the token into a bash command or into a URL.**)

Subsequent pushes (after `verify_and_commit` or any code change) use the same shape:

```
credentials_git({
  credential_id: "github",
  args: ["push", "origin", "main"]
})
```

## Step 5: Verify and Clean Up
1. Verify the output of the `git push` command.
2. If successful, tell the user congratulations, their platform is now backed up and ready for autonomous TDD evolution!
3. If it fails, read the error, explain it simply to the user, and try to fix it.