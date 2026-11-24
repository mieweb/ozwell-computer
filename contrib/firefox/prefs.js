// Installed by ozwell-computer as /etc/firefox-esr/ozwell-computer.js, and replaced on
// upgrade: put your own preferences in another file in this directory.
//
// Debian's Firefox ESR loads unsigned extensions from the system scope (8) and enables
// them without asking, but only notices new ones there when Firefox itself is upgraded.
// Scanning it at every startup lets the ozwell-computer extension
// (/usr/share/mozilla/extensions/{ec8030f7-c20a-464f-9b0e-13a3a9e97384}/ozwell-computer@mieweb.com)
// start the first time Firefox runs after the package is installed.
pref("extensions.startupScanScopes", 8);

// After a few startups that didn't finish (e.g. Firefox killed while starting), Firefox
// asks whether to start in Troubleshoot Mode, which disables extensions; nobody may be
// watching the desktop to answer. Never ask.
pref("toolkit.startup.max_resumed_crashes", -1);
