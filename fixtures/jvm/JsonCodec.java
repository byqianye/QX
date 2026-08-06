package com.qx.spike.host;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class JsonCodec {
    private JsonCodec() {
    }

    public static Object parse(String input) {
        return new Parser(input).parse();
    }

    public static Map<String, Object> parseObject(String input) {
        Object value = parse(input);
        if (!(value instanceof Map<?, ?> raw)) {
            throw new IllegalArgumentException("JSON value must be an object");
        }

        Map<String, Object> result = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : raw.entrySet()) {
            if (!(entry.getKey() instanceof String key)) {
                throw new IllegalArgumentException("JSON object key must be a string");
            }
            result.put(key, entry.getValue());
        }
        return result;
    }

    public static String stringify(Object value) {
        StringBuilder output = new StringBuilder();
        write(value, output);
        return output.toString();
    }

    private static void write(Object value, StringBuilder output) {
        if (value == null) {
            output.append("null");
        } else if (value instanceof String string) {
            writeString(string, output);
        } else if (value instanceof Boolean || value instanceof Number) {
            output.append(value);
        } else if (value instanceof Map<?, ?> map) {
            output.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (!first) output.append(',');
                first = false;
                writeString(String.valueOf(entry.getKey()), output);
                output.append(':');
                write(entry.getValue(), output);
            }
            output.append('}');
        } else if (value instanceof Iterable<?> iterable) {
            output.append('[');
            boolean first = true;
            for (Object item : iterable) {
                if (!first) output.append(',');
                first = false;
                write(item, output);
            }
            output.append(']');
        } else {
            writeString(String.valueOf(value), output);
        }
    }

    private static void writeString(String value, StringBuilder output) {
        output.append('"');
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            switch (character) {
                case '"' -> output.append("\\\"");
                case '\\' -> output.append("\\\\");
                case '\b' -> output.append("\\b");
                case '\f' -> output.append("\\f");
                case '\n' -> output.append("\\n");
                case '\r' -> output.append("\\r");
                case '\t' -> output.append("\\t");
                default -> {
                    if (character < 0x20) {
                        output.append("\\u");
                        String hex = Integer.toHexString(character);
                        for (int padding = hex.length(); padding < 4; padding++) output.append('0');
                        output.append(hex);
                    } else {
                        output.append(character);
                    }
                }
            }
        }
        output.append('"');
    }

    private static final class Parser {
        private final String input;
        private int index;

        private Parser(String input) {
            this.input = input;
        }

        private Object parse() {
            skipWhitespace();
            Object value = parseValue();
            skipWhitespace();
            if (index != input.length()) throw error("trailing JSON content");
            return value;
        }

        private Object parseValue() {
            skipWhitespace();
            if (index >= input.length()) throw error("unexpected end of JSON");
            return switch (input.charAt(index)) {
                case '{' -> parseObjectValue();
                case '[' -> parseArray();
                case '"' -> parseString();
                case 't' -> parseLiteral("true", Boolean.TRUE);
                case 'f' -> parseLiteral("false", Boolean.FALSE);
                case 'n' -> parseLiteral("null", null);
                default -> parseNumber();
            };
        }

        private Map<String, Object> parseObjectValue() {
            expect('{');
            Map<String, Object> value = new LinkedHashMap<>();
            skipWhitespace();
            if (peek('}')) {
                index++;
                return value;
            }

            while (true) {
                skipWhitespace();
                if (!peek('"')) throw error("object key must be a string");
                String key = parseString();
                skipWhitespace();
                expect(':');
                value.put(key, parseValue());
                skipWhitespace();
                if (peek('}')) {
                    index++;
                    return value;
                }
                expect(',');
            }
        }

        private List<Object> parseArray() {
            expect('[');
            List<Object> value = new ArrayList<>();
            skipWhitespace();
            if (peek(']')) {
                index++;
                return value;
            }

            while (true) {
                value.add(parseValue());
                skipWhitespace();
                if (peek(']')) {
                    index++;
                    return value;
                }
                expect(',');
            }
        }

        private String parseString() {
            expect('"');
            StringBuilder value = new StringBuilder();
            while (index < input.length()) {
                char character = input.charAt(index++);
                if (character == '"') return value.toString();
                if (character != '\\') {
                    value.append(character);
                    continue;
                }
                if (index >= input.length()) throw error("unterminated string escape");
                char escaped = input.charAt(index++);
                switch (escaped) {
                    case '"' -> value.append('"');
                    case '\\' -> value.append('\\');
                    case '/' -> value.append('/');
                    case 'b' -> value.append('\b');
                    case 'f' -> value.append('\f');
                    case 'n' -> value.append('\n');
                    case 'r' -> value.append('\r');
                    case 't' -> value.append('\t');
                    case 'u' -> value.append(parseUnicode());
                    default -> throw error("unsupported string escape");
                }
            }
            throw error("unterminated string");
        }

        private char parseUnicode() {
            if (index + 4 > input.length()) throw error("incomplete unicode escape");
            String hex = input.substring(index, index + 4);
            index += 4;
            try {
                return (char) Integer.parseInt(hex, 16);
            } catch (NumberFormatException parseError) {
                throw new IllegalArgumentException(error("invalid unicode escape").getMessage(), parseError);
            }
        }

        private Object parseLiteral(String literal, Object value) {
            if (!input.startsWith(literal, index)) throw error("invalid literal");
            index += literal.length();
            return value;
        }

        private Number parseNumber() {
            int start = index;
            if (peek('-')) index++;
            while (index < input.length() && Character.isDigit(input.charAt(index))) index++;
            if (peek('.')) {
                index++;
                while (index < input.length() && Character.isDigit(input.charAt(index))) index++;
            }
            if (peek('e') || peek('E')) {
                index++;
                if (peek('+') || peek('-')) index++;
                while (index < input.length() && Character.isDigit(input.charAt(index))) index++;
            }
            String number = input.substring(start, index);
            try {
                return number.contains(".") || number.contains("e") || number.contains("E")
                        ? new BigDecimal(number)
                        : Long.parseLong(number);
            } catch (NumberFormatException parseError) {
                throw new IllegalArgumentException(error("invalid number").getMessage(), parseError);
            }
        }

        private void expect(char expected) {
            if (index >= input.length() || input.charAt(index) != expected) {
                throw error("expected '" + expected + "'");
            }
            index++;
        }

        private boolean peek(char expected) {
            return index < input.length() && input.charAt(index) == expected;
        }

        private void skipWhitespace() {
            while (index < input.length() && Character.isWhitespace(input.charAt(index))) index++;
        }

        private IllegalArgumentException error(String message) {
            return new IllegalArgumentException(message + " at offset " + index);
        }
    }
}
