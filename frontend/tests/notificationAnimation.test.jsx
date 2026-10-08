import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ClockCalendar } from '../src/taskbar/ClockCalendar.jsx';
import { useWindowStore } from '../src/window/windowStore.js';
import {
  fluidSpring,
  accordionTransition,
  layoutTransition,
  cascadeListVariants,
  cascadeItemVariants,
  summaryMorphVariants,
} from '../src/ui/motion.js';

describe('Notification Animation System (Principle UI/UX & Apple/Samsung fluidity)', () => {
  it('defines critically-damped fluidSpring physics constants and synchronized text variants', () => {
    expect(fluidSpring.type).toBe('spring');
    expect(fluidSpring.stiffness).toBe(380);
    expect(fluidSpring.damping).toBe(34);
    expect(fluidSpring.mass).toBe(0.75);

    expect(layoutTransition).toEqual(fluidSpring);
    expect(accordionTransition.height).toEqual(fluidSpring);

    // Cascading & synchronized variants for fluid text gliding
    expect(cascadeListVariants.visible.transition.staggerChildren).toBeGreaterThan(0);
    expect(cascadeItemVariants.visible.transition).toEqual(fluidSpring);
    expect(summaryMorphVariants.visible.transition).toEqual(fluidSpring);
  });

  it('renders ClockCalendar notifications as whole-card open targets, with no redundant Uygulamayı Aç / Aç buttons', () => {
    const launchAppMock = vi.fn();
    useWindowStore.setState({ launchApp: launchAppMock });

    const sampleNotifications = [
      {
        id: 'note-1',
        appId: 'com.whatsapp',
        appName: 'WhatsApp',
        headline: 'Yeni Mesaj',
        detail: 'Ahmet: Merhaba, proje güncellemelerini test edebildiniz mi? Bildirim akışı kaymak gibi olmalı.',
        time: 'Şimdi',
      },
      {
        id: 'note-2',
        appId: 'com.whatsapp',
        appName: 'WhatsApp',
        headline: 'Grup Bildirimi',
        detail: 'Tasarım Ekibi: Yeni ikonlar eklendi.',
        time: '2 dk',
      },
    ];

    render(
      <ClockCalendar
        now={new Date()}
        notifications={sampleNotifications}
        onDismiss={vi.fn()}
      />
    );

    // Verify there are NO "Uygulamayı Aç" or standalone "Aç" buttons
    expect(screen.queryByText('Uygulamayı Aç')).not.toBeInTheDocument();
    expect(screen.queryByText('Aç')).not.toBeInTheDocument();

    // The card itself is the open target (a demo item without a phone key simply launches its app)
    const card = screen.getByRole('button', { name: /WhatsApp, Yeni Mesaj/ });
    fireEvent.click(card);
    expect(launchAppMock).toHaveBeenCalledWith('com.whatsapp');

    // Verify notification text is rendered cleanly
    expect(screen.getByText(/Merhaba, proje güncellemelerini test edebildiniz mi\?/i)).toBeInTheDocument();
  });
});
