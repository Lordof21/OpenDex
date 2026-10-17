package android.app;

import android.graphics.Bitmap;
import android.os.Binder;
import android.os.Bundle;
import android.os.IBinder;
import android.os.IInterface;
import android.os.RemoteException;

/**
 * COMPILE-ONLY stand-in for the hidden framework interface (on the device it is the real IAssistDataReceiver AIDL: the
 * Stub is a Binder the system server calls back with an app's AssistContent). build.py puts this directory on the javac
 * classpath but NEVER dexes it: a copy inside opendex-tools.jar would shadow the framework class at runtime.
 */
public interface IAssistDataReceiver extends IInterface {
    void onHandleAssistData(Bundle resultData) throws RemoteException;

    void onHandleAssistScreenshot(Bitmap screenshot) throws RemoteException;

    abstract class Stub extends Binder implements IAssistDataReceiver {
        public Stub() {}

        public IBinder asBinder() {
            return this;
        }
    }
}
