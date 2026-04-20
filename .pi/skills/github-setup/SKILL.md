---
name: github-setup
description: "Use this skill when the user wants to connect the platform to a GitHub repository, back it up, or asks how to push code to Git. It guides them through creating a repo and getting a token."
---

# GitHub Setup & Remote Configuration Workflow

You are assisting a non-technical user (e.g., a Marketing Director) in connecting this local AI platform to a GitHub repository for version control and autonomous code deployment. 

**Follow these steps sequentially. Do not overwhelm the user with all steps at once. Wait for their confirmation after each major step.**

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