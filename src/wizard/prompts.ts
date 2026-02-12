/**
 * Prompt adapter interface and implementations for the Exarchos installer wizard.
 *
 * Provides an abstract interface over interactive prompts so the wizard
 * can be tested with a mock adapter and run with @inquirer/prompts at runtime.
 */

import {
  select as inquirerSelect,
  checkbox as inquirerCheckbox,
  confirm as inquirerConfirm,
  input as inquirerInput,
} from '@inquirer/prompts';

/** A single option in a select prompt. */
export interface SelectOption<T> {
  /** Display label shown to the user. */
  readonly label: string;
  /** Value returned when this option is selected. */
  readonly value: T;
  /** Optional description shown below the label. */
  readonly description?: string;
  /** Whether this option is disabled (shown but not selectable). */
  readonly disabled?: boolean;
}

/** A single option in a multiselect prompt. */
export interface MultiselectOption<T> extends SelectOption<T> {
  /** Whether this option is pre-selected. */
  readonly selected?: boolean;
}

/**
 * Abstract interface for interactive prompts.
 *
 * Implementations handle the actual I/O (terminal prompts, mock responses, etc.)
 */
export interface PromptAdapter {
  /** Show a single-select prompt and return the chosen value. */
  select<T>(message: string, options: SelectOption<T>[]): Promise<T>;
  /** Show a multi-select prompt and return the chosen values. */
  multiselect<T>(message: string, options: MultiselectOption<T>[]): Promise<T[]>;
  /** Show a yes/no confirmation prompt. */
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
  /** Show a free-text input prompt. */
  text(message: string, placeholder?: string): Promise<string>;
}

/**
 * Interactive prompt adapter backed by @inquirer/prompts.
 *
 * Maps the PromptAdapter interface to @inquirer/prompts API calls,
 * translating option shapes between the two formats.
 */
export class InquirerPromptAdapter implements PromptAdapter {
  async select<T>(message: string, options: SelectOption<T>[]): Promise<T> {
    return inquirerSelect<T>({
      message,
      choices: options.map((opt) => ({
        name: opt.label,
        value: opt.value,
        description: opt.description,
        disabled: opt.disabled,
      })),
    });
  }

  async multiselect<T>(message: string, options: MultiselectOption<T>[]): Promise<T[]> {
    return inquirerCheckbox<T>({
      message,
      choices: options.map((opt) => ({
        name: opt.label,
        value: opt.value,
        description: opt.description,
        disabled: opt.disabled,
        checked: opt.selected,
      })),
    });
  }

  async confirm(message: string, defaultValue?: boolean): Promise<boolean> {
    return inquirerConfirm({
      message,
      default: defaultValue,
    });
  }

  async text(message: string, placeholder?: string): Promise<string> {
    return inquirerInput({
      message,
      default: placeholder,
    });
  }
}

/**
 * Mock prompt adapter for testing.
 *
 * Accepts an array of preset responses that are dequeued in FIFO order
 * as each prompt method is called.
 */
export class MockPromptAdapter implements PromptAdapter {
  private readonly responses: unknown[];
  private index = 0;

  constructor(responses: unknown[]) {
    this.responses = [...responses];
  }

  async select<T>(_message: string, _options: SelectOption<T>[]): Promise<T> {
    return this.nextResponse() as T;
  }

  async multiselect<T>(_message: string, _options: MultiselectOption<T>[]): Promise<T[]> {
    return this.nextResponse() as T[];
  }

  async confirm(_message: string, _defaultValue?: boolean): Promise<boolean> {
    return this.nextResponse() as boolean;
  }

  async text(_message: string, _placeholder?: string): Promise<string> {
    return this.nextResponse() as string;
  }

  private nextResponse(): unknown {
    if (this.index >= this.responses.length) {
      throw new Error('MockPromptAdapter: no more preset responses');
    }
    return this.responses[this.index++];
  }
}

/**
 * Create an interactive prompt adapter for terminal use.
 *
 * @returns An InquirerPromptAdapter instance.
 */
export function createPromptAdapter(): PromptAdapter {
  return new InquirerPromptAdapter();
}
