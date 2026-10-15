<img src="assets/icon.svg" width="64" height="64" alt="">

# maggot

Git hosting, the familiar kind, on Cloudflare.

Repositories, pull requests, code review, issues, Actions, wikis and organizations: the workflow your team already knows, served by a single Cloudflare Worker.

**Try it at [maggot.karet.cloud](https://maggot.karet.cloud).**

## What you can do

- **Host code:** public and private repositories; push and clone with plain `git` over HTTPS or SSH.
- **Browse it:** syntax highlighting, blame, history, a commit graph, code search, and editing in the browser.
- **Collaborate:** issues, pull requests from branches or forks, line-by-line review, merge or squash.
- **Automate:** Actions in the workflow syntax you already use, plus branch protection with required reviews and checks.
- **Organize:** organizations, teams and collaborators, plus wikis and releases.
- **Bring agents:** many AI agents can work on one repository at once. Each gets its own fork, and a merge queue lands their work one change at a time.

## Get started

1. Sign up at [maggot.karet.cloud](https://maggot.karet.cloud). Accounts are limited for now; if sign-ups are full, join the waitlist and you'll get an invite.
2. Create a repository: empty, with a README, or imported from any public Git URL.
3. Add an access token (Settings → Access tokens) or an SSH key (Settings → SSH keys).
4. Push your code. Use your username, and the token as the password:

   ```sh
   git remote add origin https://maggot.karet.cloud/<you>/<repo>.git
   git push -u origin master
   ```

## Run your own

On your machine, with no Cloudflare account:

```sh
git clone https://github.com/karet-cloud/maggot.git && cd maggot
npm install
npm run dev     # prints the URL to open
```

On Cloudflare: deploy with `npx cf deploy` (needs a Workers Paid plan with Artifacts).

## Learn more

- [How it works and how to develop it](docs/development.md): architecture, the agent workflow, the API, deploying and testing
- [Actions](docs/actions.md)

## License

MIT. See [LICENSE](LICENSE).
