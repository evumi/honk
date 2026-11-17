.PHONY: setup test build

# One-time: the nsh AARs into app/libs.
setup:
	../scripts/fetch-nsh-android.sh

# :core's JVM tests (LocalStore, sync, gateway client); needs only a JDK 17.
test:
	./gradlew :core:test

# Everything; needs the Android SDK (platform 35) and app/libs from `make setup`.
build:
	./gradlew test assembleDebug
