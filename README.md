# Text Display

Puts congregation messages on screen during a service. Someone pastes messages
in on a submission page, a moderator clears them, and the cleared ones are
rendered on a full-bleed display page suitable for a browser source, a second
monitor, or an NDI feed.

## The two halves

The app is deliberately split, because the two jobs want different machines:

| Part | Where it runs | What it does |
| --- | --- | --- |
| **Server** | Linux, in Docker | Hosts the submit / admin / parked / display pages and owns the data |
| **NDI sender** | Windows, in the booth | Renders the display page and puts it on the video network |

The server is plain Node with **no runtime dependencies**, so the container is
small and needs no native builds. NDI wants a GPU and a real video network, so
it stays on the Windows machine where NDI Tools already lives.

Running everything on one Windows machine also works - just launch the app
without `TEXT_DISPLAY_SERVER` and it hosts the server itself.

## Running the server

```sh
docker compose up -d
```

Then open `http://<server>:4321/submit`.

Configuration is by environment variable:

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `4321` | Port to listen on |
| `TEXT_DISPLAY_DATA` | `/data` | Where messages and settings are written |
| `TEXT_DISPLAY_ADMIN_LOCALHOST_ONLY` | `0` in the image | See below |

Data lives on the `text-display-data` volume, so rebuilding the image never
takes the message history or display settings with it.

### A note on access

The admin pages have no login. Outside Docker the app defaults to refusing
admin requests from other machines, but behind a bridge network every request
arrives from the gateway rather than loopback, so that guard would lock
everyone out - the image therefore turns it off. **Anyone who can reach port
4321 can put text on the screen**, so keep it on a staff network rather than
exposing it.

## Running the NDI sender

On the Windows machine in the booth, install the app and point it at the
server:

```
set TEXT_DISPLAY_SERVER=http://textdisplay.lan:4321
"Text Display.exe"
```

With that variable set the app starts no server of its own. It opens the
hosted display page offscreen and sends it as NDI.

Requirements:

- **The NDI runtime**, which comes with [NDI Tools](https://ndi.video/tools/).
  It is not shipped with this app - it belongs to Vizrt and is not ours to
  redistribute. The app finds it through the `NDI_RUNTIME_DIR_V*` variables the
  NDI installer sets, or you can point at it with `TEXT_DISPLAY_NDI_LIB`.
- **A Windows Firewall allowance** for the app, or NDI discovery is blocked and
  nothing on the network will see the feed.

### Feed settings

Set from **NDI output** in the admin panel, from any machine - the settings
live on the server and are pushed to the sender, which reconfigures itself
without a restart:

- **Send the feed** - on/off
- **Feed name** - receivers see `MACHINE (name)`
- **Resolution** - presets or custom
- **Frame rate**
- **Alpha channel** - needs the display background set to **transparent**
  under Background, or the feed keys to a solid colour

The panel shows what the sender actually reports: whether it is on air, how
many receivers are connected, and the resolution genuinely going out, which is
not always the one requested.

## Development

```sh
npm run serve     # the server alone, no Electron
npm start         # Electron: server + windows + NDI sender
npm run dist      # build the Windows installer
```

The display page is the single source of truth for what goes to air. The admin
preview is that same page in an iframe, and the NDI feed is that same page
rendered offscreen, so all three agree by construction.

## Deployment

Production runs in Docker on the sandbox server at **10.101.6.12:4321**.

Deployment is push-to-deploy: the server hosts a bare repo whose
`post-receive` hook checks out `main`, rebuilds the image and restarts the
container, then asks the running app which commit it reports before calling
the deploy a success. A copy of that hook lives in `deploy/post-receive`.

```sh
git push            # goes to GitHub AND deploys to the server
git push origin     # same thing
git push production # deploy only, skipping GitHub
```

`git push` has two push URLs configured, so one command sends the code to
GitHub for history and to the server to go live. Only `main` deploys; other
branches are accepted and ignored.

To check what is live, look at the version in the admin header - it reads
`v0.2.0 · 7f671d1` and the tooltip gives the branch, commit time and image
build time. A dev instance running from a working copy is outlined and shows
a trailing `+` when there are uncommitted changes.

To deploy by hand, or to see why one failed:

```sh
ssh sandbox@10.101.6.12 '~/text-display/deploy.sh'
ssh sandbox@10.101.6.12 'tail -40 ~/text-display-deploy.log'
```

Data lives on the `text-display_text-display-data` Docker volume, so rebuilds
and redeploys never touch the message history or display settings.

## Running the sender on a Mac

The sender works on macOS, but the installer has to be **built on a Mac** -
electron-builder cannot cross-compile a macOS app from Windows.

```sh
git clone <this repo>
cd Text-Display
npm install
npm run dist:mac        # produces dist/*.dmg and dist/*.zip
```

Then set it up exactly as on Windows: open it, choose **Send NDI for a hosted
server**, enter the server address, Test, Save & restart.

Things specific to macOS:

- **Build for the Mac's own architecture.** `npm install` only fetches the
  koffi binary for the machine it runs on, so building an Intel app on an
  Apple-silicon Mac (or the reverse) ships without the FFI the NDI binding
  needs and the feed will not start. Build on the architecture you intend to
  run, or run `npm install` again on the other one.
- **The NDI runtime is still required** and is not shipped with the app. NDI
  Tools for Mac installs it; the app looks in `/usr/local/lib`,
  `/opt/homebrew/lib` and the SDK folders, or set `TEXT_DISPLAY_NDI_LIB` to
  the dylib.
- **The app is unsigned**, so Gatekeeper will refuse it on first launch.
  Right-click the app and choose Open, or clear the quarantine flag:
  `xattr -dr com.apple.quarantine "/Applications/Text Display.app"`.
  Signing properly needs an Apple Developer account.
- **On a Retina Mac the app's own admin window renders at 1x** and will look
  small. Display scaling is switched off deliberately so the feed comes out at
  exactly the resolution asked for, and on macOS there is no way to exempt one
  window. Use the admin panel in a browser instead, where scaling is native -
  which is the usual way to drive it anyway.
- Settings live in `~/Library/Application Support/TextDisplay`.
