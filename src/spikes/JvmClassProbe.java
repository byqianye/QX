import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Path;

public final class JvmClassProbe {
    private JvmClassProbe() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 2) {
            throw new IllegalArgumentException("usage: JvmClassProbe <jar> <class>");
        }

        Path artifact = Path.of(args[0]);
        String targetClass = args[1];
        try (URLClassLoader loader = new URLClassLoader(
                new URL[]{artifact.toUri().toURL()},
                null)) {
            Class<?> loaded = Class.forName(targetClass, false, loader);
            System.out.println("LOADED\t" + loaded.getName());
        } catch (ClassNotFoundException error) {
            System.out.println("NOT_FOUND\t" + error.getMessage());
            System.exit(2);
        } catch (Throwable error) {
            System.out.println("ERROR\t" + error.getClass().getName() + "\t" + error.getMessage());
            System.exit(3);
        }
    }
}
