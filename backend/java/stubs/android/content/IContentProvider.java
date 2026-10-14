package android.content;

/**
 * COMPILE-ONLY stand-in for the hidden framework interface (on the device it is the real IContentProvider, the Binder
 * interface of a content provider). build.py puts this directory on the javac classpath but NEVER dexes it: a copy inside
 * opendex-tools.jar would shadow the framework type. ShellContext passes instances through and asks one for its Binder
 * (is the provider's process still alive?), so the stub is an IInterface and declares nothing else.
 */
public interface IContentProvider extends android.os.IInterface {}
