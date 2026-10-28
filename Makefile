.DEFAULT_GOAL := help

PREFIX  ?= /opt/ozwell-desktop
DESTDIR ?= /

# `make deb` stages into this directory; pass DESTDIR=... to use another one.
STAGE := $(if $(filter command line,$(origin DESTDIR)),$(DESTDIR),$(CURDIR)/.pkg/buildroot)

DESTAPP  := $(DESTDIR)$(PREFIX)
UNIT_DIR := $(DESTDIR)/usr/lib/systemd/system
XFCONF   := $(DESTDIR)/etc/xdg/xfce4/xfconf/xfce-perchannel-xml
UNITS    := ozwell-desktop.service ozwell-desktop-dbus.service ozwell-desktop-xvfb.service ozwell-desktop-session.service \
            ozwell-desktop-upgrade.service ozwell-desktop-upgrade.path

INSTALL      := install
INSTALL_DATA := $(INSTALL) -m 0644

.PHONY: help deps build test install deb clean

help:
	@echo "ozwell-desktop"
	@echo ""
	@echo "Targets:"
	@echo "  deps     install dependencies (npm ci)"
	@echo "  build    compile the server and copy viewer assets (npm run build)"
	@echo "  test     run the full test suite (npm test; uses the compose dev container)"
	@echo "  install  stage the application, units and config into DESTDIR (default /)"
	@echo "  deb      build ozwell-desktop_<version>_amd64.deb with fpm"
	@echo "  clean    remove build output, the staging directory and built packages"
	@echo ""
	@echo "Variables: PREFIX (default /opt/ozwell-desktop), DESTDIR (default /;"
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
	# Runtime dependencies only, and the release version (the installed app has no git checkout).
	cd $(DESTAPP) && npm prune --omit=dev --no-audit --no-fund >/dev/null \
		&& npm pkg set version="$$($(CURDIR)/package-version node)"
	$(INSTALL) -m 0755 contrib/xfce/session.sh $(DESTAPP)/bin/ozwell-desktop-session
	$(INSTALL) -m 0755 contrib/upgrade.sh $(DESTAPP)/bin/ozwell-desktop-upgrade
	$(INSTALL) -d $(DESTDIR)/usr/bin
	ln -sf $(PREFIX)/dist/cli.js $(DESTDIR)/usr/bin/ozwell-desktop
	$(INSTALL) -d $(UNIT_DIR)
	for u in $(UNITS); do \
		sed 's|@PREFIX@|$(PREFIX)|g' contrib/systemd/$$u > $(UNIT_DIR)/$$u && chmod 0644 $(UNIT_DIR)/$$u || exit 1; \
	done
	$(INSTALL) -d $(DESTDIR)/etc/default $(XFCONF) $(DESTDIR)/usr/share/applications
	$(INSTALL_DATA) contrib/default/ozwell-desktop $(DESTDIR)/etc/default/ozwell-desktop
	$(INSTALL_DATA) contrib/xfce/mimeapps.list $(DESTDIR)/etc/xdg/mimeapps.list
	$(INSTALL_DATA) contrib/xfce/xfconf/*.xml $(XFCONF)/
	$(INSTALL_DATA) contrib/xfce/applications/*.desktop $(DESTDIR)/usr/share/applications/

deb:
	@case "$(STAGE)" in /|"") echo "refusing to package from DESTDIR=$(STAGE)" >&2; exit 1;; esac
	rm -rf $(STAGE)
	$(MAKE) install DESTDIR=$(STAGE) PREFIX=$(PREFIX)
	fpm -s dir -t deb -v "$$(./package-version deb)" -C $(STAGE) -p $(CURDIR) -f .

clean:
	rm -rf dist .pkg
	rm -f *.deb
