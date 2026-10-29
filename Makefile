.DEFAULT_GOAL := help

PREFIX  ?= /opt/ozwell-computer
DESTDIR ?= /

# `make deb` stages into this directory; pass DESTDIR=... to use another one.
STAGE := $(if $(filter command line,$(origin DESTDIR)),$(DESTDIR),$(CURDIR)/.pkg/buildroot)

DESTAPP  := $(DESTDIR)$(PREFIX)
UNIT_DIR := $(DESTDIR)/usr/lib/systemd/system
XFCONF   := $(DESTDIR)/etc/xdg/xfce4/xfconf/xfce-perchannel-xml
# Read through XDG_CONFIG_DIRS (see ozwell-computer-dbus.service).
APP_XFCONF := $(DESTAPP)/xdg/xfce4/xfconf/xfce-perchannel-xml
UNITS    := ozwell-computer.service ozwell-computer-dbus.service ozwell-computer-xvfb.service ozwell-computer-session.service \
            ozwell-computer-upgrade.service ozwell-computer-upgrade.path

INSTALL      := install
INSTALL_DATA := $(INSTALL) -m 0644
# Config files (dpkg conffiles): keep an existing copy, like apt's --force-confold.
conffile = [ -e $(2) ] || $(INSTALL_DATA) $(1) $(2)

.PHONY: help deps build test install deb clean

help:
	@echo "ozwell-computer"
	@echo ""
	@echo "Targets:"
	@echo "  deps     install dependencies (npm ci)"
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

build:
	npm run build

test:
	npm test

install: build
	$(INSTALL) -d $(DESTAPP) $(DESTAPP)/bin
	cp -a dist package.json package-lock.json node_modules $(DESTAPP)/
	chmod 0755 $(DESTAPP)/dist/cli.js
	# Runtime dependencies only, and the release version (the installed app has no git checkout).
	cd $(DESTAPP) && npm prune --omit=dev --no-audit --no-fund >/dev/null \
		&& npm pkg set version="$$(cd "$(CURDIR)" && ./package-version node)"
	$(INSTALL) -m 0755 contrib/xfce/session.sh $(DESTAPP)/bin/ozwell-computer-session
	sed 's|@PREFIX@|$(PREFIX)|g' contrib/upgrade.sh > $(DESTAPP)/bin/ozwell-computer-upgrade
	chmod 0755 $(DESTAPP)/bin/ozwell-computer-upgrade
	$(INSTALL) -d $(DESTDIR)/usr/bin
	ln -sf $(PREFIX)/dist/cli.js $(DESTDIR)/usr/bin/ozwell-computer
	$(INSTALL) -d $(UNIT_DIR)
	for u in $(UNITS); do \
		sed 's|@PREFIX@|$(PREFIX)|g' contrib/systemd/$$u > $(UNIT_DIR)/$$u && chmod 0644 $(UNIT_DIR)/$$u || exit 1; \
	done
	$(INSTALL) -d $(DESTDIR)/etc/default $(XFCONF) $(DESTDIR)/usr/share/applications
	$(call conffile,contrib/default/ozwell-computer,$(DESTDIR)/etc/default/ozwell-computer)
	$(call conffile,contrib/xfce/mimeapps.list,$(DESTDIR)/etc/xdg/mimeapps.list)
	for f in contrib/xfce/xfconf/*.xml; do $(call conffile,$$f,$(XFCONF)/$${f##*/}) || exit 1; done
	$(INSTALL) -d $(APP_XFCONF)
	$(INSTALL_DATA) contrib/xfce/xfce4-session.xml $(APP_XFCONF)/
	$(INSTALL_DATA) contrib/xfce/applications/*.desktop $(DESTDIR)/usr/share/applications/
	# Last: the source commit marks a complete install for in-app updates from git (contrib/upgrade.sh).
	git rev-parse --verify -q HEAD > $(DESTAPP)/REVISION 2>/dev/null || rm -f $(DESTAPP)/REVISION

deb:
	@case "$(STAGE)" in /|"") echo "refusing to package from DESTDIR=$(STAGE)" >&2; exit 1;; esac
	rm -rf $(STAGE)
	$(MAKE) install DESTDIR=$(STAGE) PREFIX=$(PREFIX)
	fpm -s dir -t deb -v "$$(./package-version deb)" -C $(STAGE) -p $(CURDIR) -f .

clean:
	rm -rf dist .pkg
	rm -f *.deb
