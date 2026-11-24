# Included by ../Makefile (paths are relative to the repository root).
#
# What is installed in $(PREFIX)/bin, generated from a template next to it, so the
# checkout mirrors the installed tree: bin/X is bin/X.in with @PREFIX@ filled in.
BIN := $(patsubst %.in,%,$(wildcard bin/*.in))

bin/%: bin/%.in
	sed 's|@PREFIX@|$(PREFIX)|g' $< > $@.tmp
	chmod 0755 $@.tmp
	mv $@.tmp $@
