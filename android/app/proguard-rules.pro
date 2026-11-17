# nsh.aar carries its own rules (com.longbridge.nsh stays as it is).
# kotlinx.serialization: keep the generated serializers of :core's models.
-keepattributes *Annotation*, InnerClasses
-keepclassmembers class dev.evumi.honk.core.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class dev.evumi.honk.core.**$$serializer { *; }
