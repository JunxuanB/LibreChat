import React from 'react';
import { render } from '@testing-library/react';
import Spinner from './Spinner';

type FakeAnimation = { startTime: number | null };

const mockGetAnimations = (impl: () => FakeAnimation[]) => {
  const getAnimations = jest.fn(impl);
  Object.defineProperty(SVGElement.prototype, 'getAnimations', {
    configurable: true,
    value: getAnimations,
  });
  return getAnimations;
};

const flushMicrotasks = () => Promise.resolve();

describe('Spinner', () => {
  afterEach(() => {
    delete (SVGElement.prototype as Partial<SVGElement>).getAnimations;
  });

  it('pins its rotation to the document timeline origin so spinners share one phase', async () => {
    const animation: FakeAnimation = { startTime: 1234 };
    mockGetAnimations(() => [animation]);

    render(<Spinner />);
    await flushMicrotasks();

    expect(animation.startTime).toBe(0);
  });

  it('pins every animation on the svg', async () => {
    const animations: FakeAnimation[] = [{ startTime: 10 }, { startTime: 20 }];
    mockGetAnimations(() => animations);

    render(<Spinner />);
    await flushMicrotasks();

    expect(animations.map((a) => a.startTime)).toEqual([0, 0]);
  });

  it('reads every animation before writing any start time when spinners mount together', async () => {
    const animations: FakeAnimation[] = [{ startTime: 1 }, { startTime: 2 }, { startTime: 3 }];
    const writesSeenAtRead: number[] = [];
    let next = 0;
    mockGetAnimations(() => {
      writesSeenAtRead.push(animations.filter((a) => a.startTime === 0).length);
      return [animations[next++]];
    });

    render(
      <>
        <Spinner />
        <Spinner />
        <Spinner />
      </>,
    );
    await flushMicrotasks();

    expect(writesSeenAtRead).toEqual([0, 0, 0]);
    expect(animations.map((a) => a.startTime)).toEqual([0, 0, 0]);
  });

  it('does not touch the animations of a spinner that unmounted before the batch ran', async () => {
    const animation: FakeAnimation = { startTime: 99 };
    const getAnimations = mockGetAnimations(() => [animation]);

    render(<Spinner />).unmount();
    await flushMicrotasks();

    expect(getAnimations).not.toHaveBeenCalled();
    expect(animation.startTime).toBe(99);
  });

  it('renders when the browser has no Web Animations API', async () => {
    const { container } = render(<Spinner />);
    await flushMicrotasks();

    expect(container.querySelector('svg')).not.toBeNull();
  });
});
