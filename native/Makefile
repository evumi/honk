# Card scripts: quickjs-ng (quickjs/) and the card sandbox (card/), shared by
# the iOS and Android apps. `make test` builds and runs the C tests here.

CC ?= cc
QJS = quickjs/quickjs.c quickjs/libregexp.c quickjs/libunicode.c quickjs/dtoa.c
QJS_FLAGS = -std=gnu11 -D_GNU_SOURCE -w -O2 -fPIC
CARD_FLAGS = -std=gnu11 -Wall -Wextra -Werror -Wno-unused-parameter -O1 -g -Iquickjs -Icard/include
BUILD = build

.PHONY: test asan jni runtime check clean

test: $(BUILD)/card_test
	$(BUILD)/card_test

runtime:
	python3 card/gen_runtime.py

check:
	python3 card/gen_runtime.py --check

$(BUILD)/qjs.a: $(QJS) | $(BUILD)
	cd $(BUILD) && $(CC) $(QJS_FLAGS) -c $(addprefix ../,$(QJS)) && ar rcs qjs.a quickjs.o libregexp.o libunicode.o dtoa.o

# The tests build without NDEBUG: QuickJS then asserts that a closed card freed every value.
$(BUILD)/card_test: card/test/card_test.c card/honk_card.c card/include/honk_card.h card/runtime_js.h $(BUILD)/qjs.a
	$(CC) $(CARD_FLAGS) -Icard -o $@ card/test/card_test.c card/honk_card.c $(BUILD)/qjs.a -lm -lpthread

# The same tests under AddressSanitizer and UBSan (leak checks where the platform has them).
asan: | $(BUILD)
	$(CC) -std=gnu11 -D_GNU_SOURCE -w -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer -Iquickjs -Icard -Icard/include \
		-o $(BUILD)/card_test_asan card/test/card_test.c card/honk_card.c $(QJS) -lm -lpthread
	$(BUILD)/card_test_asan

# The JNI library for android/core's tests on this machine (JAVA_HOME: a JDK).
JNI_OS = $(if $(filter Darwin,$(shell uname)),darwin,linux)
JNI_LIB = $(BUILD)/$(if $(filter Darwin,$(shell uname)),libhonkcard.dylib,libhonkcard.so)
jni: $(JNI_LIB)
$(JNI_LIB): card/honk_card.c card/include/honk_card.h card/runtime_js.h jni/honk_card_jni.c $(BUILD)/qjs.a
	$(CC) -std=gnu11 -shared -fPIC -O1 -g -Iquickjs -Icard -Icard/include -I"$(JAVA_HOME)/include" -I"$(JAVA_HOME)/include/$(JNI_OS)" \
		-o $@ card/honk_card.c jni/honk_card_jni.c $(BUILD)/qjs.a -lm -lpthread

$(BUILD):
	mkdir -p $(BUILD)

clean:
	rm -rf $(BUILD)
