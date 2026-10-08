# OpenDeX Java Tools - Maximum Obfuscation & Shrinking ProGuard/R8 Rules

-dontusemixedcaseclassnames
-allowaccessmodification
-overloadaggressively
-repackageclasses 'com.opendex.tools.internal'

# Strip debug info
-renamesourcefileattribute ''
-keepattributes !SourceFile,!LineNumberTable,*Annotation*

# Keep CLI Entry points
-keepclasseswithmembers public class com.opendex.tools.OpenDexDaemon {
    public static void main(java.lang.String[]);
}
-keepclasseswithmembers public class com.opendex.tools.IconExtractor {
    public static void main(java.lang.String[]);
}
-keepclasseswithmembers public class com.opendex.tools.NotificationInvoker {
    public static void main(java.lang.String[]);
}
-keepclasseswithmembers public class com.opendex.tools.MediaBridge {
    public static void main(java.lang.String[]);
}
-keepclasseswithmembers public class com.opendex.tools.AudioProbe {
    public static void main(java.lang.String[]);
}

# Keep classes referenced dynamically by daemon / reflection
-keep class com.opendex.tools.Bluetooth { *; }
-keep class com.opendex.tools.Wifi { *; }
-keep class com.opendex.tools.AudioRouter { *; }
-keep class com.opendex.tools.AudioStreamServer { *; }
-keep class com.opendex.tools.TaskEvents { *; }
-keep class com.opendex.tools.DisplayEvents { *; }
-keep class com.opendex.tools.NotificationEvents { *; }
-keep class com.opendex.tools.ThermalEvents { *; }
-keep class com.opendex.tools.EventLogReader { *; }
-keep class com.opendex.tools.LoadProbe { *; }
-keep class com.opendex.tools.Battery { *; }
-keep class com.opendex.tools.BinderDump { *; }

# Keep enum methods and serialization
-keepclassmembers class * {
    public static ** valueOf(java.lang.String);
    public static **[] values();
}

-dontwarn android.**
-dontwarn com.opendex.tools.**
-dontnote **

# ShellContext's ContentResolver subclass implements hidden abstract methods of ContentResolver (the android.jar R8 sees does
# not declare them, so without this rule they would be renamed or dropped and the framework's call hits AbstractMethodError).
-keepclassmembers class com.opendex.tools.ShellContext$ShellResolver { *; }
