.PHONY: setup project test sim run-sim

# One-time: the nsh frameworks and the generated Xcode project.
setup:
	../scripts/fetch-nsh-ios.sh
	$(MAKE) project

# Needs XcodeGen (brew install xcodegen).
project:
	../scripts/build-nsh-bundle.sh
	xcodegen generate
	../scripts/check-entitlements.sh

# HonkKit's tests. With full Xcode `swift test` is enough; with only the
# Command Line Tools, swift-testing lives outside the default search path.
CLT_FW := /Library/Developer/CommandLineTools/Library/Developer/Frameworks
CLT_LIB := /Library/Developer/CommandLineTools/Library/Developer/usr/lib
test:
	cd HonkKit && if xcode-select -p | grep -q CommandLineTools; then \
		swift test -Xswiftc -F -Xswiftc $(CLT_FW) -Xlinker -F -Xlinker $(CLT_FW) \
			-Xlinker -rpath -Xlinker $(CLT_FW) -Xlinker -rpath -Xlinker $(CLT_LIB); \
	else swift test; fi

# Simulator builds (Apple silicon only: nsh ships arm64 simulator slices).
# `make sim` builds; `make run-sim` also boots the simulator, installs and
# launches. SIM picks the device: `make run-sim SIM="iPhone 17 Pro"`.
# Without a team in Config/Local.xcconfig the app is signed to run locally
# (ad hoc), which keeps the entitlements; a Debug simulator build with no
# APNs token registers with a simulator identity (see docs/DESIGN.zh-CN.md).
SIM ?= iPhone 17
BUNDLE_ID ?= $(shell sed -n 's/^HONK_BUNDLE_ID *= *//p' Config/Local.xcconfig 2>/dev/null | tail -1)
BUNDLE_ID := $(if $(BUNDLE_ID),$(BUNDLE_ID),dev.evumi.honk)
TEAM := $(shell sed -n 's/^DEVELOPMENT_TEAM *= *//p' Config/Local.xcconfig 2>/dev/null | tail -1)
SIM_SIGNING := $(if $(TEAM),,CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual)
APP := build/Build/Products/Debug-iphonesimulator/Honk.app

sim:
	xcodebuild -project Honk.xcodeproj -scheme Honk -configuration Debug \
		-destination 'platform=iOS Simulator,arch=arm64,name=$(SIM)' \
		-derivedDataPath build ONLY_ACTIVE_ARCH=YES $(SIM_SIGNING) build

run-sim: sim
	xcrun simctl boot "$(SIM)" 2>/dev/null || true
	open -a Simulator
	xcrun simctl install "$(SIM)" "$(APP)"
	xcrun simctl launch "$(SIM)" "$(BUNDLE_ID)"
