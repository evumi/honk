.PHONY: setup project test

# One-time: the nsh frameworks and the generated Xcode project.
setup:
	../scripts/fetch-nsh-ios.sh
	$(MAKE) project

# Needs XcodeGen (brew install xcodegen).
project:
	../scripts/build-nsh-bundle.sh
	xcodegen generate

# HonkKit's tests. With full Xcode `swift test` is enough; with only the
# Command Line Tools, swift-testing lives outside the default search path.
CLT_FW := /Library/Developer/CommandLineTools/Library/Developer/Frameworks
CLT_LIB := /Library/Developer/CommandLineTools/Library/Developer/usr/lib
test:
	cd HonkKit && if xcode-select -p | grep -q CommandLineTools; then \
		swift test -Xswiftc -F -Xswiftc $(CLT_FW) -Xlinker -F -Xlinker $(CLT_FW) \
			-Xlinker -rpath -Xlinker $(CLT_FW) -Xlinker -rpath -Xlinker $(CLT_LIB); \
	else swift test; fi
