.DEFAULT_GOAL := help

PREFIX  ?= /opt/ozwell-computer
DESTDIR ?= /

# `make deb` stages into this directory; pass DESTDIR=... to use another one.
STAGE := $(if $(filter command line,$(origin DESTDIR)),$(DESTDIR),$(CURDIR)/.pkg/buildroot)

DESTAPP  := $(DESTDIR)$(PREFIX)
UNIT_DIR := $(DESTDIR)/usr/lib/systemd/system
XFCONF   := $(DESTDIR)/etc/xdg/xfce4/xfconf/xfce-perchannel-xml
# Read through XDG_CONFIG_DIRS (see ozwell-computer-desktop.service).
APP_XFCONF := $(DESTAPP)/xdg/xfce4/xfconf/xfce-perchannel-xml
APP_AUTOSTART := $(DESTAPP)/xdg/autostart
UNITS    := ozwell-computer.service ozwell-computer-desktop.service ozwell-computer-upgrade.service ozwell-computer-upgrade.path
# Replaced by ozwell-computer-desktop.service.
LEGACY_UNITS := ozwell-computer-session.service ozwell-computer-xvfb.service ozwell-computer-dbus.service

INSTALL      := install
INSTALL_DATA := $(INSTALL) -m 0644
# Config files (dpkg conffiles): keep an existing copy, like apt's --force-confold.
conffile = [ -e $(2) ] || $(INSTALL_DATA) $(1) $(2)

.PHONY: help deps system-deps build test install deb clean

help:
	@echo "ozwell-computer"
	@echo ""
	@echo "Targets:"
	@echo "  deps     install dependencies (npm ci)"
	@echo "  system-deps  apt-get install the runtime packages listed in .fpm (root)"
	@echo "  build    compile the server and build the viewer (npm run build)"
	@echo "  test     run the full test suite (npm test; uses the compose dev container)"
	@echo "  install  stage the application, units and config into DESTDIR (default /)"
	@echo "  deb      build ozwell-computer_<version>_amd64.deb with fpm"
	@echo "  clean    remove build output, the staging directory and built packages"
	@echo ""
	@echo "Variables: PREFIX (default /opt/ozwell-computer), DESTDIR (default /;"
	@echo "for deb, default .pkg/buildroot). The version comes from git: ./package-version deb"

deps:
	npm ci

# The same list the image installs. A real install (DESTDIR=/) runs it too, so updaters
# older than this target still get packages a new commit adds.
system-deps:
	DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 update || echo "apt-get update reported errors; continuing"
	DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends \
		$$(sed -n 's/^--depends "\{0,1\}\([^ "]*\).*/\1/p' .fpm | grep -vx nodejs)

build:
	npm run build

test:
	npm test

install: build $(if $(filter /,$(DESTDIR)),system-deps)
	$(INSTALL) -d $(DESTAPP) $(DESTAPP)/bin
	cp -a dist package.json package-lock.json node_modules $(DESTAPP)/
	chmod 0755 $(DESTAPP)/dist/cli.js
	# Runtime dependencies only, and the release version (the installed app has no git checkout).
	cd $(DESTAPP) && npm prune --omit=dev --no-audit --no-fund >/dev/null \
		&& npm pkg set version="$$(cd "$(CURDIR)" && ./package-version node)"
	sed 's|@PREFIX@|$(PREFIX)|g' contrib/upgrade.sh > $(DESTAPP)/bin/ozwell-computer-upgrade
	chmod 0755 $(DESTAPP)/bin/ozwell-computer-upgrade
	$(INSTALL) -d $(DESTDIR)/usr/bin
	ln -sf $(PREFIX)/dist/cli.js $(DESTDIR)/usr/bin/ozwell-computer
	$(INSTALL) -d $(UNIT_DIR)
	for u in $(UNITS); do \
		sed 's|@PREFIX@|$(PREFIX)|g' contrib/systemd/$$u > $(UNIT_DIR)/$$u && chmod 0644 $(UNIT_DIR)/$$u || exit 1; \
	done
	# Updating a real install from before ozwell-computer-desktop.service (the .deb does this in postinst).
	[ "$(DESTDIR)" != / ] || { enabled=; for u in $(LEGACY_UNITS); do \
		[ -e $(UNIT_DIR)/$$u ] || continue; \
		if systemctl is-enabled --quiet $$u; then enabled=1; fi; \
		systemctl disable --now $$u >/dev/null 2>&1; rm -f $(UNIT_DIR)/$$u; \
	done; rm -f $(DESTAPP)/bin/ozwell-computer-session; \
	if [ -n "$$enabled" ]; then systemctl enable ozwell-computer-desktop.service >/dev/null; fi; }
	$(INSTALL) -d $(DESTDIR)/etc/default $(DESTDIR)/etc/pam.d $(XFCONF) $(DESTDIR)/usr/share/applications
	$(call conffile,contrib/default/ozwell-computer,$(DESTDIR)/etc/default/ozwell-computer)
	$(call conffile,contrib/pam/ozwell-computer,$(DESTDIR)/etc/pam.d/ozwell-computer)
	$(call conffile,contrib/xfce/mimeapps.list,$(DESTDIR)/etc/xdg/mimeapps.list)
	for f in contrib/xfce/xfconf/*.xml; do $(call conffile,$$f,$(XFCONF)/$${f##*/}) || exit 1; done
	$(INSTALL) -d $(APP_XFCONF)
	$(INSTALL_DATA) contrib/xfce/xfce4-session.xml contrib/xfce/xsettings.xml $(APP_XFCONF)/
	$(INSTALL) -d $(APP_AUTOSTART)
	$(INSTALL_DATA) contrib/xfce/autostart/*.desktop $(APP_AUTOSTART)/
	$(INSTALL_DATA) contrib/xfce/applications/*.desktop $(DESTDIR)/usr/share/applications/
	# Last: the source commit marks a complete install for in-app updates from git (contrib/upgrade.sh).
	rev=$$(git rev-parse --verify -q HEAD 2>/dev/null); if [ -n "$$rev" ]; then echo "$$rev" > $(DESTAPP)/REVISION; else rm -f $(DESTAPP)/REVISION; fi

deb:
	@case "$(STAGE)" in /|"") echo "refusing to package from DESTDIR=$(STAGE)" >&2; exit 1;; esac
	rm -rf $(STAGE)
	$(MAKE) install DESTDIR=$(STAGE) PREFIX=$(PREFIX)
	fpm -s dir -t deb -v "$$(./package-version deb)" -C $(STAGE) -p $(CURDIR) -f .

clean:
	rm -rf dist .pkg
	rm -f *.deb
