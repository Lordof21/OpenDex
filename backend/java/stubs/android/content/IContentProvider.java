package android.content;

/**
 * COMPILE-ONLY stand-in for the hidden framework interface (on the device it is the real IContentProvider, the Binder
 * interface of a content provider). build.py puts this directory on the javac classpath but NEVER dexes it: a copy inside
 * opendex-tools.jar would shadow the framework type. ShellContext only passes instances through, so no method is declared.
 */
public interface IContentProvider {}
