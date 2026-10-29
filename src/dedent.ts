// From https://github.com/MartinKolarik/dedent-js/blob/master/src/index.ts - MIT © 2015 Martin Kolárik
export function dedent(
	templateStrings: TemplateStringsArray | string,
	...values: unknown[]
): string {
	const matches: string[] = []
	const strings = typeof templateStrings === 'string'
		? [templateStrings]
		: templateStrings.slice()
	strings[strings.length - 1] = strings[strings.length - 1].replace(
		/\r?\n([\t ]*)$/,
		'',
	)
	for (let i = 0; i < strings.length; i++) {
		let match
		if ((match = strings[i].match(/\n[\t ]+/g))) {
			matches.push(...match)
		}
	}
	if (matches.length) {
		const size = Math.min(...matches.map((value) => value.length - 1))
		const pattern = new RegExp(`\n[\t ]{${size}}`, 'g')
		for (let i = 0; i < strings.length; i++) {
			strings[i] = strings[i].replace(pattern, '\n')
		}
	}
	strings[0] = strings[0].replace(/^\r?\n/, '')
	let string = strings[0]
	for (let i = 0; i < values.length; i++) {
		// Concatenated as they are, like the original, so that null prints as null
		string += (values[i] as string) + strings[i + 1]
	}
	return string
}
