# fledge

Build, install and release a Flutter app from a local web UI.

Pick the platforms, flavors and build types (debug / profile / release). fledge
queues every combination, runs one Android and one iOS build at a time with
live logs, installs finished builds on a connected phone, and cuts the release:
version bump, GitHub (pre-)release, Jira updates, and notes drafted with Claude.

## Install

fledge is installed from its GitHub releases. You need the GitHub CLI (`gh`),
logged in with an account that can see this repository:

```sh
gh release download --repo yonatantasew/fledge --pattern '*.tgz' --dir /tmp/fledge --clobber
npm install -g /tmp/fledge/*.tgz
```

The package is prebuilt, so installing it runs no scripts. To update, run the
same two lines again.

Then run it:

```sh
fledge                 # → http://localhost:4417
fledge --help          # --repo, --config, --port
```

Run inside an app's folder, fledge opens that app, adding it to your list if
it's new. Run anywhere else, it opens your list of apps.

**Needs:** macOS, Node ≥ 20.11, and `fvm` or `flutter` on `PATH`.

**Optional:**
- **Installing on devices:** Xcode (`xcrun devicectl`) and the Android SDK (`adb`).
- **Releases:** `gh`, plus `acli` for Jira and the `claude` CLI for drafting notes.
- **The Firebase sign-in badge:** `firebase`.

## Apps and their configs

fledge manages several Flutter apps from one window: pick the app in the
header, then its checkout. **+** adds an app: pick one of the Flutter apps
fledge finds in your usual folders, or type its path. fledge then looks at it
and suggests a config, with a note for everything it found or guessed:

- flavors and application IDs, from `productFlavors` in `android/app/build.gradle(.kts)`
- iOS bundle IDs and schemes, from `project.pbxproj` and the shared Xcode schemes
- the flavor and commit defines, and on/off switches, from the
  `String.fromEnvironment` / `bool.fromEnvironment` keys your Dart code reads
- the GitHub repo, its base branch and which of your `gh` accounts can see it
- the ticket prefix and version-bump conventions, from recent commits and branches
- the Jira statuses to move between, from the statuses your recent tickets use
- team names, from the GitHub profiles of recent PR authors

You review and edit it before saving. The gear button edits it later, or
detects it again.

Each app's config is the first of these that exists:

1. a file given with `fledge --config <file>` when the app was opened
2. **your config on this Mac**, in `~/.config/fledge/projects/<app>.json`
3. the **`fledge.json` in the app's repository**, a default shared with the team

Saving in fledge always writes your own file (2), so a personal setup wins
over the team's shared one without changing the repository. The list of apps
is in `~/.config/fledge/projects.json`. Set `FLEDGE_HOME` to keep both
somewhere else.

## Config format

Start from [fledge.example.json](fledge.example.json). The fields:

| Field | Meaning |
|---|---|
| `flavors[]` | One per `--flavor`. `name` (lowercase), `label`, `androidId` / `iosId` (used when the ID can't be read back from the build), `xcodeScheme` (for Prepare Xcode; defaults to the capitalised name), `confirm` (ask twice before building it, e.g. production). |
| `flavorDefine` | Passes `--dart-define=<this>=<flavor>` on every build, so Dart code and the native flavor always agree. Default `FLAVOR`; `null` to leave it out. |
| `gitShaDefine` | Passes the checkout's commit as `--dart-define=<this>=<sha>`. Default `GIT_SHA`; `null` to leave it out. |
| `defines` | Extra `--dart-define`s for every build. |
| `symbolsDir` | Where split debug info goes. Default `build/symbols/{flavor}/{platform}`. |
| `toggles[]` | On/off switches in the form, each adding one `--dart-define` (e.g. a debug-logging flag). `skipFlavors` lists flavors it's never added to. |
| `release` | Optional. Without it the Release tab is turned off. |
| `release.github` | `repo` (`owner/name`); `account` (which logged-in `gh` account to use, if you have several); `baseBranch` (default `main`). |
| `release.channel` | First line of the channel note. |
| `release.tickets.project` | Ticket key prefix to find in PR titles and branches (`PROJ-123`). `PROJ-0` / `PROJ-0000` means "no ticket". |
| `release.versionBump` | Templates for the bump `branch`, `commitMessage`, `prTitle` and `prBody` (an array of lines). Placeholders: `{version}`, `{tag}`, `{versionSlug}` (`1-3-1-4`), `{date}`, `{baseBranch}`, `{headShort}`, `{bumpShort}`, `{releaseKind}`. If your repo checks PR titles or bodies, match its rules here. |
| `release.jira` | Optional. `site`, and the `fromStatus` → `toStatus` move to make when a release ships. |
| `release.team` | GitHub login → the name used for "DRI" in the notes. |

## Builds

- **Any worktree.** The checkout picker lists every `git worktree` of the
  app's repository, so you can build `main` or a feature branch without
  switching.
- **Shared build slots across apps.** The one-Android-and-one-iOS limit below
  covers all apps together, since they share `~/.gradle`, Xcode and the CPU.
  With several apps, the build list shows which app each build belongs to.
- **One Android and one iOS build at a time.** Builds of the same platform wait
  their turn: two Gradle builds fight over `~/.gradle`'s locks, and two iOS
  builds would overwrite each other's `Generated.xcconfig`. "Prepare Xcode"
  jobs share the iOS slot. `pub get` is the one step both platforms share, so
  fledge runs it itself, once per checkout at a time, skips it while `pubspec`
  hasn't changed, and starts the builds with `--no-pub`. Set `MAX_PARALLEL=1`
  to run one build at a time.
- **Android builds of one type run back to back.** In the Android queue, a
  build with the same checkout and build type (debug/profile/release) as the
  last one goes next. Gradle compiles plugins per build type, not per flavor,
  so release builds for several flavors in a row reuse each other's work.
  Otherwise the queue is first in, first out.
- **Stop all** cancels everything queued and stops running builds, including
  Gradle and `xcodebuild`.
- **Every artifact is kept.** Each finished build is copied to
  `build/fledge/<time>-<platform>-<flavor>-<mode>/` with its symbols,
  `build.log` and `job.json`, so the next build can't overwrite it. The list is
  reloaded from these folders on restart.
- **What was built is read back.** The version and bundle ID come from the
  artifact itself: `Info.plist` for iOS, `aapt2` for APKs.

| Platform | Output | Notes |
|---|---|---|
| Android | APK, App Bundle | Signing comes from the app's Gradle setup. |
| iOS | IPA | Export method: App Store, Ad hoc or Development. The `.xcarchive` is kept for Organizer. There is no debug IPA. |
| iOS | `.app` | A device build, for `xcrun devicectl device install app`. |
| iOS | Prepare Xcode | Builds nothing. Sets Xcode up for one flavor; see [Xcode](#xcode). |

**Android: 64-bit ARM phones only** (off by default) compiles the Dart code
for 64-bit ARM alone, instead of once per CPU type, so profile and release
builds finish faster. What you give up:
- Phones that run 32-bit Android (many low-end and Android Go phones) can't use
  the build. Plugin code for them stays in the APK, so such a phone would
  install it and crash; fledge's Install checks the phone first and refuses.
- It isn't the build your users get, so it's not for testers or store upload.

The file is named `…-arm64.apk`, and the build list marks it.

## Installing on a device

Finished APK, `.app` and Development or Ad hoc IPA builds have an **Install**
button. It lists connected phones: Android through `adb` (emulators too), and
iPhones through `xcrun devicectl`, over cable or Wi-Fi once the phone trusts
this Mac. **Open the app after installing** is off by default.

- **Android** uses `adb install -r -d`, which keeps the app's data. If the phone
  refuses, because the installed app is signed with another key or has a
  higher build number, the menu offers **Replace**. Replace uninstalls first,
  which deletes the app's data, so it only runs when you pick it.
- **iOS** installs the `.app`; an IPA is unpacked first. App Store IPAs only
  install through TestFlight. Debug builds are installed but not launched,
  because they need a debugger.
- App Bundles (`.aab`) can't be installed directly.

## Releases

Uses the logins already on your Mac: `gh`, `acli` (Jira) and `claude`. fledge
stores no tokens.

1. **Range:** pick the last release. fledge lists every PR merged to the base
   branch since then, with its DRI, size, tickets and their live Jira status,
   and whether it's stacked on another PR. Untick a PR to leave it out.
2. **Notes:** the channel note and the GitHub release body start from a
   template. **Draft with Claude** rewrites the item titles for testers, groups
   related PRs under Rollback and lists what to check before posting (missing
   tickets, unexpected statuses and so on). It runs `claude -p` with no tools.
   Both texts stay editable.
3. **Publish**, after you type the tag to confirm. In a temporary worktree,
   fledge commits the version bump on top of the base branch, pushes the bump
   branch, opens the PR, and creates the GitHub (pre-)release on that commit.
   Optionally it moves tickets in Jira and comments the release link on each.
   **Dry run** does everything up to the commit, prints the rest, and discards
   it.

If a GitHub workflow already updates Jira on release, turn **Update Jira from
here** off, or every ticket gets two comments.

## Xcode

- **Distribute from an IPA build (preferred).** An IPA build keeps the
  `.xcarchive` that `flutter build ipa` made on the way. Its archive button
  opens it in Xcode's Organizer for **Distribute App**. No config step or
  restart is needed, because the archive already has the flavor's settings.
- **Prepare Xcode**, for archiving by hand. It writes the flavor's
  `ios/Flutter/Generated.xcconfig` (`--config-only`) and checks the flavor in
  it. Then it quits Xcode (which still asks about unsaved changes), reopens
  `ios/Runner.xcworkspace` and selects the flavor's scheme. Without the
  restart, Xcode keeps the previous flavor's settings in memory and archives
  with them.

Every build rewrites `Generated.xcconfig`, so run Prepare Xcode before
archiving in Xcode after any other build.

## Firebase

The header shows which account the Firebase CLI is signed in as. It checks
with a real request, because `firebase login:list` keeps showing an expired
login. When it's signed out, **Log in to Firebase** runs
`firebase login --reauth --interactive` and opens Google sign-in.

## Safety

The server listens on `127.0.0.1` only. It rejects requests whose `Host` or
`Origin` isn't fledge, which blocks DNS rebinding and cross-site POSTs. Commands
are built from fixed lists and the checked `fledge.json`, never through a
shell. A device ID must match a device that's connected at that moment, and
Publish refuses a tag or branch that already exists.

## Development

Running from a clone needs Node ≥ 23.6, which runs the TypeScript server
directly.

```sh
npm install
npm run dev -- --repo /path/to/app   # Vite hot reload through the same server
npm start -- --repo /path/to/app     # build the UI, then serve it
npm test                             # node:test
npm run typecheck
npm run build                        # what the installed command runs: dist/ and dist-server/
npm run release                      # tests, packs and publishes a GitHub release of "version"
```

To ship a new version, bump `version` in `package.json`, commit and push to
`main`, then run `npm run release`.

The UI is React with Tailwind v4, [shadcn/ui](https://ui.shadcn.com) components
in `src/components/ui`, and [Hugeicons](https://hugeicons.com). When adding a
component with `npx shadcn add`, replace any `lucide-react` icons with
`@hugeicons/core-free-icons`, change `from "cn"` to `from "@/lib/utils"`, and
revert the unrelated `cn` package it adds to `package.json`. The CLI gets all
three wrong for this setup.
