import type { Cursor } from "../ansi/cursor_position.ts";
import { Tty, tty } from "../ansi/tty.ts";
import { KeyCode, parse } from "../keycode/key_code.ts";
import {
  bold,
  brightBlue,
  dim,
  green,
  italic,
  red,
  stripColor,
  yellow,
} from "./deps.ts";
import { Figures } from "./figures.ts";

/** Static generic prompt interface. */
export interface StaticGenericPrompt<
  TValue,
  TRawValue,
  TOptions extends GenericPromptOptions<TValue, TRawValue> =
    GenericPromptOptions<TValue, TRawValue>,
> {
  inject?(value: TValue): void;

  prompt(options: TOptions): Promise<TValue>;
}

/** Generic prompt options. */
export interface GenericPromptOptions<TValue, TRawValue> {
  message: string;
  default?: TValue;
  hideDefault?: boolean;
  validate?: (value: TRawValue) => ValidateResult;
  transform?: (value: TRawValue) => TValue | undefined;
  hint?: string;
  pointer?: string;
  indent?: string;
  keys?: GenericPromptKeys;
  cbreak?: boolean;
  prefix?: string;
  reader?: Deno.Reader & {
    readonly rid: number;
    setRaw(mode: boolean, options?: Deno.SetRawOptions): void;
  };
  writer?: Deno.WriterSync;
}

/** Generic prompt settings. */
export interface GenericPromptSettings<TValue, TRawValue>
  extends GenericPromptOptions<TValue, TRawValue> {
  pointer: string;
  indent: string;
  prefix: string;
  cbreak: boolean;
  tty: Tty;
  reader: Deno.Reader & {
    readonly rid: number;
    setRaw(mode: boolean, options?: Deno.SetRawOptions): void;
  };
  writer: Deno.WriterSync;
}

/** Prompt validation return tape. */
export type ValidateResult = string | boolean | Promise<string | boolean>;

/** Input keys options. */
export interface GenericPromptKeys {
  submit?: Array<string>;
}

/** Generic prompt representation. */
export abstract class GenericPrompt<
  TValue,
  TRawValue,
> {
  protected static injectedValue: unknown | undefined;
  protected abstract readonly settings: GenericPromptSettings<
    TValue,
    TRawValue
  >;
  protected readonly cursor: Cursor = {
    x: 0,
    y: 0,
  };
  #value: TValue | undefined;
  #lastError: string | undefined;
  #isFirstRun = true;
  #encoder = new TextEncoder();

  /**
   * Inject prompt value. Can be used for unit tests or pre selections.
   * @param value Input value.
   */
  public static inject(value: unknown): void {
    GenericPrompt.injectedValue = value;
  }

  protected getDefaultSettings(
    options: GenericPromptOptions<TValue, TRawValue>,
  ): GenericPromptSettings<TValue, TRawValue> {
    return {
      ...options,
      tty: tty({
        // Stdin is only used by getCursorPosition which we don't need.
        reader: Deno.stdin,
        writer: options.writer ?? Deno.stdout,
      }),
      cbreak: options.cbreak ?? false,
      reader: options.reader ?? Deno.stdin,
      writer: options.writer ?? Deno.stdout,
      pointer: options.pointer ?? brightBlue(Figures.POINTER_SMALL),
      prefix: options.prefix ?? yellow("? "),
      indent: options.indent ?? "",
      keys: {
        submit: ["enter", "return"],
        ...(options.keys ?? {}),
      },
    };
  }

  /** Execute the prompt and show cursor on end. */
  public async prompt(): Promise<TValue> {
    try {
      return await this.#execute();
    } finally {
      this.settings.tty.cursorShow();
    }
  }

  /** Clear prompt output. */
  protected clear(): void {
    this.settings.tty.cursorLeft.eraseDown();
  }

  /** Execute the prompt. */
  #execute = async (): Promise<TValue> => {
    // Throw errors on unit tests.
    if (typeof GenericPrompt.injectedValue !== "undefined" && this.#lastError) {
      throw new Error(this.error());
    }

    await this.render();
    this.#lastError = undefined;

    if (!await this.read()) {
      return this.#execute();
    }

    if (typeof this.#value === "undefined") {
      throw new Error("internal error: failed to read value");
    }

    this.clear();
    const successMessage: string | undefined = this.success(
      this.#value,
    );

    if (successMessage) {
      this.settings.writer.writeSync(
        this.#encoder.encode(successMessage + "\n"),
      );
    }

    GenericPrompt.injectedValue = undefined;
    this.settings.tty.cursorShow();

    return this.#value;
  };

  /** Render prompt. */
  protected async render(): Promise<void> {
    const result: [string, string | undefined, string | undefined] =
      await Promise.all([
        this.message(),
        this.body?.(),
        this.footer(),
      ]);

    const content: string = result.filter(Boolean).join("\n");
    const lines = content.split("\n");

    const columns = getColumns();
    const linesCount: number = columns
      ? lines.reduce((prev, next) => {
        const length = stripColor(next).length;
        return prev + (length > columns ? Math.ceil(length / columns) : 1);
      }, 0)
      : content.split("\n").length;

    const y: number = linesCount - this.cursor.y - 1;

    if (!this.#isFirstRun || this.#lastError) {
      this.clear();
    }
    this.#isFirstRun = false;
    Deno.writeSync(1,this.#encoder.encode(content));

    if (y) {
      this.settings.tty.cursorUp(y);
    }
    this.settings.tty.cursorTo(this.cursor.x);
  }

  /** Read user input from stdin, handle events and validate user input. */
  protected async read(): Promise<boolean> {
    if (typeof GenericPrompt.injectedValue !== "undefined") {
      const value: TRawValue = GenericPrompt.injectedValue as TRawValue;
      await this.#validateValue(value);
    } else {
      const events: Array<KeyCode> = await this.#readKey();

      if (!events.length) {
        return false;
      }

      for (const event of events) {
        await this.handleEvent(event);
      }
    }

    return typeof this.#value !== "undefined";
  }

  protected submit(): Promise<void> {
    return this.#validateValue(this.getValue());
  }

  protected message(): string {
    return `${this.settings.indent}${this.settings.prefix}` +
      bold(this.settings.message) + this.defaults();
  }

  protected defaults(): string {
    let defaultMessage = "";
    if (
      typeof this.settings.default !== "undefined" && !this.settings.hideDefault
    ) {
      defaultMessage += dim(` (${this.format(this.settings.default)})`);
    }
    return defaultMessage;
  }

  /** Get prompt success message. */
  protected success(value: TValue): string | undefined {
    return `${this.settings.indent}${this.settings.prefix}` +
      bold(this.settings.message) + this.defaults() +
      " " + this.settings.pointer +
      " " + green(this.format(value));
  }

  protected body?(): string | undefined | Promise<string | undefined>;

  protected footer(): string | undefined {
    return this.error() ?? this.hint();
  }

  protected error(): string | undefined {
    return this.#lastError
      ? this.settings.indent + red(bold(`${Figures.CROSS} `) + this.#lastError)
      : undefined;
  }

  protected hint(): string | undefined {
    return this.settings.hint
      ? this.settings.indent +
        italic(brightBlue(dim(`${Figures.POINTER} `) + this.settings.hint))
      : undefined;
  }

  protected setErrorMessage(message: string) {
    this.#lastError = message;
  }

  /**
   * Handle user input event.
   * @param event Key event.
   */
  protected async handleEvent(event: KeyCode): Promise<void> {
    switch (true) {
      case event.name === "c" && event.ctrl:
        this.clear();
        this.settings.tty.cursorShow();
        Deno.exit(130);
        return;
      case this.isKey(this.settings.keys, "submit", event):
        await this.submit();
        break;
    }
  }

  /**
   * Map input value to output value.
   * @param value Input value.
   * @return Output value.
   */
  protected abstract transform(value: TRawValue): TValue | undefined;

  /**
   * Validate input value.
   * @param value User input value.
   * @return True on success, false or error message on error.
   */
  protected abstract validate(value: TRawValue): ValidateResult;

  /**
   * Format output value.
   * @param value Output value.
   */
  protected abstract format(value: TValue): string;

  /** Get input value. */
  protected abstract getValue(): TRawValue;

  /** Read user input from stdin and pars ansi codes. */
  #readKey = async (): Promise<Array<KeyCode>> => {
    const data: Uint8Array = await this.#readChar();

    return data.length ? parse(data) : [];
  };

  /** Read user input from stdin. */
  #readChar = async (): Promise<Uint8Array> => {
    const buffer = new Uint8Array(8);
    const isTty = Deno.isatty(this.settings.reader.rid);

    if (isTty) {
      this.settings.reader.setRaw(
        true,
        { cbreak: this.settings.cbreak },
      );
    }
    const nread: number | null = await this.settings.reader.read(buffer);

    if (isTty) {
      this.settings.reader.setRaw(false);
    }

    if (nread === null) {
      return buffer;
    }

    return buffer.subarray(0, nread);
  };

  /**
   * Map input value to output value. If a custom transform handler ist set, the
   * custom handler will be executed, otherwise the default transform handler
   * from the prompt will be executed.
   * @param value The value to transform.
   */
  #transformValue = (value: TRawValue): TValue | undefined => {
    return this.settings.transform
      ? this.settings.transform(value)
      : this.transform(value);
  };

  /**
   * Validate input value. Set error message if validation fails and transform
   * output value on success.
   * If a default value is set, the default will be used as value without any
   * validation.
   * If a custom validation handler ist set, the custom handler will
   * be executed, otherwise a prompt specific default validation handler will be
   * executed.
   * @param value The value to validate.
   */
  #validateValue = async (value: TRawValue): Promise<void> => {
    if (!value && typeof this.settings.default !== "undefined") {
      this.#value = this.settings.default;
      return;
    }

    this.#value = undefined;
    this.#lastError = undefined;

    const validation =
      await (this.settings.validate
        ? this.settings.validate(value)
        : this.validate(value));

    if (validation === false) {
      this.#lastError = `Invalid answer.`;
    } else if (typeof validation === "string") {
      this.#lastError = validation;
    } else {
      this.#value = this.#transformValue(value);
    }
  };

  /**
   * Check if key event has given name or sequence.
   * @param keys  Key map.
   * @param name  Key name.
   * @param event Key event.
   */
  protected isKey<TKey extends unknown, TName extends keyof TKey>(
    keys: TKey | undefined,
    name: TName,
    event: KeyCode,
  ): boolean {
    // deno-lint-ignore no-explicit-any
    const keyNames: Array<unknown> | undefined = keys?.[name] as any;
    return typeof keyNames !== "undefined" && (
      (typeof event.name !== "undefined" &&
        keyNames.indexOf(event.name) !== -1) ||
      (typeof event.sequence !== "undefined" &&
        keyNames.indexOf(event.sequence) !== -1)
    );
  }
}

function getColumns(): number | null {
  try {
    // Catch error in none tty mode: Inappropriate ioctl for device (os error 25)
    return Deno.consoleSize().columns ?? null;
  } catch (_error) {
    return null;
  }
}
