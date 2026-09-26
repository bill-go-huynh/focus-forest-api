import { Global, Module } from '@nestjs/common';

/** The source of the current time. Inject it instead of calling `new Date()` in logic. */
export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

/** A clock that only moves when told to. For tests and simulations. */
export class FixedClock extends Clock {
  private current: number;

  constructor(start: Date) {
    super();
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(date: Date): void {
    this.current = date.getTime();
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

@Global()
@Module({
  providers: [{ provide: Clock, useClass: SystemClock }],
  exports: [Clock],
})
export class ClockModule {}
