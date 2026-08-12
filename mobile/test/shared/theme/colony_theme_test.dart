import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:buzz/shared/theme/theme.dart';
import 'package:buzz/shared/widgets/frosted_app_bar.dart';
import 'package:shared_preferences/shared_preferences.dart';

Future<SharedPreferences> _prefs(Map<String, Object> initial) async {
  SharedPreferences.setMockInitialValues(initial);
  return SharedPreferences.getInstance();
}

ProviderContainer _container(SharedPreferences prefs) {
  final container = ProviderContainer(
    overrides: [savedPrefsProvider.overrideWithValue(prefs)],
  );
  addTearDown(container.dispose);
  return container;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('Colony theme catalog entries', () {
    test('both halves are in the catalog', () {
      expect(findTheme(colonyThemeName), isNotNull);
      expect(findTheme(colonyDarkThemeName), isNotNull);
    });

    test('borrow the GitHub palettes', () {
      final colony = findTheme(colonyThemeName)!;
      final github = findTheme('github-light')!;
      expect(colony.bg, github.bg);
      expect(colony.fg, github.fg);
      expect(colony.comment, github.comment);

      final colonyDark = findTheme(colonyDarkThemeName)!;
      final githubDark = findTheme('github-dark')!;
      expect(colonyDark.bg, githubDark.bg);
      expect(colonyDark.fg, githubDark.fg);
      expect(colonyDark.comment, githubDark.comment);
    });

    test('are a light/dark pair', () {
      expect(findTheme(colonyThemeName)!.isDark, isFalse);
      expect(findTheme(colonyDarkThemeName)!.isDark, isTrue);
      expect(themePairFor(colonyThemeName), colonyDarkThemeName);
      expect(themePairFor(colonyDarkThemeName), colonyThemeName);
    });

    test('appear as a single System-mode option labelled "Colony"', () {
      final paired = themeGroups().paired.map((t) => t.name);
      expect(paired, contains(colonyThemeName));
      expect(paired, isNot(contains(colonyDarkThemeName)));
      expect(pairedThemeLabel(colonyThemeName), 'Colony');
      expect(themeSelectionLabel(colonyThemeName, ThemeMode.system), 'Colony');
      expect(
        themeSelectionLabel(colonyDarkThemeName, ThemeMode.system),
        'Colony',
      );
    });

    test('forces neutral rendering without changing the stored accent', () {
      const storedAccent = '#ef4444';

      expect(
        effectiveAccentIndex(colonyThemeName, storedAccent),
        neutralAccentIndex,
      );
      expect(
        effectiveAccentIndex(colonyDarkThemeName, storedAccent),
        neutralAccentIndex,
      );
      expect(
        effectiveAccentIndex('github-light', storedAccent),
        accentIndexForWireValue(storedAccent),
      );
      expect(storedAccent, '#ef4444');
    });

    test('resolve across brightnesses like any other pair', () {
      final resolved = resolveSchemes(colonyThemeName, ThemeMode.system);
      expect(resolved.forcedMode, isNull);
      expect(resolved.light.brightness, Brightness.light);
      expect(resolved.dark.brightness, Brightness.dark);
      expect(resolved.lightTheme?.name, colonyThemeName);
      expect(resolved.darkTheme?.name, colonyDarkThemeName);

      expect(
        effectiveTheme(colonyThemeName, ThemeMode.dark)?.name,
        colonyDarkThemeName,
      );
      expect(
        effectiveTheme(colonyDarkThemeName, ThemeMode.light)?.name,
        colonyThemeName,
      );
    });

    test(
      'fallbacks expose the effective Colony theme for gradient selection',
      () {
        final coerced = resolveSchemes('nord', ThemeMode.light);
        expect(coerced.lightTheme?.name, colonyThemeName);
        expect(
          colonyTopSectionGradient(
            coerced.lightTheme!.name,
            coerced.light.brightness,
          ),
          isNotNull,
        );

        final unknown = resolveSchemes('not-a-theme', ThemeMode.light);
        expect(unknown.lightTheme?.name, colonyThemeName);
        expect(
          colonyTopSectionGradient(
            unknown.lightTheme!.name,
            unknown.light.brightness,
          ),
          isNotNull,
        );
      },
    );
  });

  group('legacy scheme name migration', () {
    test('a stored "buzz" resolves to Colony and is written back', () async {
      final prefs = await _prefs({'buzz_color_scheme': 'buzz'});

      expect(_container(prefs).read(schemeProvider), colonyThemeName);
      expect(prefs.getString('buzz_color_scheme'), colonyThemeName);
    });

    test(
      'a stored "buzz-dark" resolves to Colony Dark and is written back',
      () async {
        final prefs = await _prefs({'buzz_color_scheme': 'buzz-dark'});

        expect(_container(prefs).read(schemeProvider), colonyDarkThemeName);
        expect(prefs.getString('buzz_color_scheme'), colonyDarkThemeName);
      },
    );

    test('an unrelated stored scheme passes through untouched', () async {
      // Pinned to Light mode on purpose: System mode normalizes any unpaired
      // selection, which would hide whether the migration itself rewrote it.
      final prefs = await _prefs({
        'buzz_theme_mode': 'light',
        'buzz_color_scheme': 'nord',
      });

      expect(_container(prefs).read(schemeProvider), 'nord');
      expect(prefs.getString('buzz_color_scheme'), 'nord');
    });

    test('migrates the stored value, not the preference key', () async {
      final prefs = await _prefs({'buzz_color_scheme': 'buzz'});
      _container(prefs).read(schemeProvider);

      expect(prefs.getKeys(), contains('buzz_color_scheme'));
      expect(prefs.getKeys(), isNot(contains('colony_color_scheme')));
    });

    test('a fresh install with no stored scheme still defaults to Colony', () {
      expect(defaultSchemeName, colonyThemeName);
      expect(defaultSchemeDisplayName, 'Colony');
      expect(effectiveTheme(null, ThemeMode.light)?.name, colonyThemeName);
    });
  });

  group('colonyTopSectionGradient', () {
    test('is null for non-Colony themes', () {
      expect(
        colonyTopSectionGradient('github-light', Brightness.light),
        isNull,
      );
      expect(colonyTopSectionGradient('nord', Brightness.dark), isNull);
    });

    test('paints top to bottom for both halves of the pair', () {
      for (final name in [colonyThemeName, colonyDarkThemeName]) {
        final gradient = colonyTopSectionGradient(name, Brightness.light);
        expect(gradient, isNotNull, reason: '$name should be gradient-backed');
        expect(gradient!.begin, Alignment.topCenter);
        expect(gradient.end, Alignment.bottomCenter);
        expect(gradient.colors, hasLength(2));
      }
    });

    test('brightness selects the stops, not the theme name', () {
      // Both halves enable the gradient, so System mode keeps it on across an
      // OS switch: the applied brightness alone decides which stops are used.
      final light = colonyTopSectionGradient(
        colonyThemeName,
        Brightness.light,
      )!;
      final dark = colonyTopSectionGradient(colonyThemeName, Brightness.dark)!;

      expect(light.colors, isNot(dark.colors));
      expect(
        colonyTopSectionGradient(colonyDarkThemeName, Brightness.dark)!.colors,
        dark.colors,
      );
      expect(
        colonyTopSectionGradient(colonyDarkThemeName, Brightness.light)!.colors,
        light.colors,
      );
    });

    test('is opaque so the color replaces the frosted fill', () {
      for (final brightness in Brightness.values) {
        final gradient = colonyTopSectionGradient(colonyThemeName, brightness)!;
        for (final color in gradient.colors) {
          expect(color.a, 1.0);
        }
      }
    });
  });

  group('theme threading', () {
    BoxDecoration barDecoration(WidgetTester tester) {
      final container = tester
          .widgetList<Container>(
            find.descendant(
              of: find.byType(FrostedAppBar),
              matching: find.byType(Container),
            ),
          )
          .first;
      return container.decoration! as BoxDecoration;
    }

    Widget harness(ThemeData theme) => MaterialApp(
      theme: theme,
      home: Builder(
        builder: (context) => Stack(
          children: [
            FrostedAppBar(
              gradient: context.appColors.topSectionGradient,
              title: const Text('Home'),
            ),
          ],
        ),
      ),
    );

    testWidgets('AppTheme carries the gradient to the top section', (
      tester,
    ) async {
      await tester.pumpWidget(
        harness(
          AppTheme.light(
            topSectionGradient: colonyTopSectionGradient(
              colonyThemeName,
              Brightness.light,
            ),
          ),
        ),
      );

      final decoration = barDecoration(tester);
      expect(decoration.gradient, isNotNull);
      // A BoxDecoration cannot paint a color and a gradient at once.
      expect(decoration.color, isNull);
    });

    testWidgets('non-Colony themes keep the frosted surface fill', (
      tester,
    ) async {
      await tester.pumpWidget(harness(AppTheme.light()));

      final decoration = barDecoration(tester);
      expect(decoration.gradient, isNull);
      expect(decoration.color, isNotNull);
    });

    testWidgets('Colony section labels use 80% neutral foreground', (
      tester,
    ) async {
      await tester.pumpWidget(
        harness(
          AppTheme.light(
            topSectionGradient: colonyTopSectionGradient(
              colonyThemeName,
              Brightness.light,
            ),
          ),
        ),
      );

      final context = tester.element(find.text('Home'));
      expect(
        navigationSectionForeground(context),
        Colors.black.withValues(alpha: 0.8),
      );
    });

    testWidgets('navigation roles inherit non-Colony theme tokens', (
      tester,
    ) async {
      const primaryForeground = Color(0xFF123456);
      const secondaryForeground = Color(0xFF789ABC);
      const searchSurface = Color(0xFFDEF012);
      final theme = ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.purple).copyWith(
          onSurface: primaryForeground,
          onSurfaceVariant: secondaryForeground,
          surfaceContainerHighest: searchSurface,
        ),
      );

      await tester.pumpWidget(
        MaterialApp(
          theme: theme,
          home: const Scaffold(body: SizedBox()),
        ),
      );

      final context = tester.element(find.byType(SizedBox));
      expect(navigationPrimaryForeground(context), primaryForeground);
      expect(navigationSecondaryForeground(context), secondaryForeground);
      expect(navigationSectionForeground(context), secondaryForeground);
      expect(navigationSearchSurface(context), searchSurface);
      expect(
        navigationDivider(context, 0.15),
        primaryForeground.withValues(alpha: 0.15),
      );
    });
  });

  group('isColonyTheme', () {
    test('matches only the Colony pair', () {
      expect(isColonyTheme(colonyThemeName), isTrue);
      expect(isColonyTheme(colonyDarkThemeName), isTrue);
      expect(isColonyTheme('github-light'), isFalse);
      expect(isColonyTheme(''), isFalse);
    });
  });
}
