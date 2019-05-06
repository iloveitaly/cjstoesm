import {
	CallExpression,
	createIdentifier,
	createImportClause,
	createImportDeclaration,
	createImportSpecifier,
	createNamedImports,
	createNamespaceImport,
	createObjectLiteral,
	createPropertyAssignment,
	createShorthandPropertyAssignment,
	createStringLiteral,
	ElementAccessExpression,
	Identifier,
	ImportSpecifier,
	isBinaryExpression,
	isCallExpression,
	isElementAccessExpression,
	isExpressionStatement,
	isIdentifier,
	isNewExpression,
	isObjectBindingPattern,
	isPropertyAccessExpression,
	isStringLiteralLike,
	isVariableDeclaration,
	Node,
	PropertyAccessExpression,
	VisitResult
} from "typescript";
import {BeforeVisitorOptions} from "../before-visitor-options";
import {isRequireCall} from "../../../util/is-require-call";
import {findNodeUp} from "../../../util/find-node-up";
import {isStatementOrDeclaration} from "../../../util/is-statement-or-declaration";
import {isStatement} from "../../../util/is-statement";
import {generateNameFromModuleSpecifier} from "../../../util/generate-name-from-module-specifier";
import {getModuleExportsFromRequireDataInContext} from "../../../util/get-module-exports-from-require-data-in-context";

/**
 * Visits the given CallExpression
 * @param {BeforeVisitorOptions<CallExpression>} options
 * @returns {VisitResult<CallExpression>}
 */
export function visitCallExpression({node, childContinuation, sourceFile, context}: BeforeVisitorOptions<CallExpression>): VisitResult<Node> {
	if (context.onlyExports) {
		return childContinuation(node);
	}

	// Check if the node represents a require(...) call.
	const requireData = isRequireCall(node, sourceFile, context);

	// If it doesn't proceed without applying any transformations
	if (!requireData.match) {
		return childContinuation(node);
	}

	// Otherwise, spread out the things we know about the require call
	const {moduleSpecifier} = requireData;

	// If no module specifier could be determined, remove the CallExpression from the SourceFile
	if (moduleSpecifier == null) {
		return undefined;
	}

	// If we've been able to resolve a module as well as its contents,
	// Check it for exports so that we know more about its internals, for example whether or not it has any named exports, etc
	const moduleExports = getModuleExportsFromRequireDataInContext(requireData, context);

	// Find the first ExpressionStatement going up from the Node, breaking if part of a BinaryExpression, CallExpression, or a NewExpression
	const expressionStatementParent = findNodeUp(node, isExpressionStatement, currentNode => isBinaryExpression(currentNode) || isCallExpression(currentNode) || isNewExpression(currentNode));

	// If we don't know anything about the exports of the module, or if it doesn't export any named exports,
	// there's really not much we can do in terms of using the context of the CallExpression to import the maximally
	// minimal subset of the module. In these cases, the only thing that can be done is to import the default
	// export and maybe return an identifier for it depending on whether or not the CallExpression is part of an ExpressionStatement
	if (moduleExports == null || moduleExports.namedExports.size === 0 || (expressionStatementParent != null && !moduleExports.hasDefaultExport)) {
		// If part of an ExpressionStatement, simply return the module without any name or other bindings
		if (expressionStatementParent != null) {
			// Only add the import if there isn't already an import within the SourceFile of the entire module without any bindings
			if (!context.isModuleSpecifierImportedWithoutLocals(moduleSpecifier)) {
				context.addImport(createImportDeclaration(undefined, undefined, undefined, createStringLiteral(moduleSpecifier)));
			}

			// Drop this CallExpression
			return undefined;
		}

		// Otherwise, we need to give the module a name and replace the CallExpression with an identifier for it
		else {
			// If the default export is already imported, get the local binding name for it and create an identifier for it
			// rather than generating a new unnecessary import
			if (context.hasLocalForDefaultImportFromModule(moduleSpecifier)) {
				const local = context.getLocalForDefaultImportFromModule(moduleSpecifier)!;
				return createIdentifier(local);
			} else {
				const identifier = createIdentifier(context.getFreeIdentifier(generateNameFromModuleSpecifier(moduleSpecifier)));
				context.addImport(createImportDeclaration(undefined, undefined, createImportClause(identifier, undefined), createStringLiteral(moduleSpecifier)));

				// Replace the CallExpression by the identifier
				return identifier;
			}
		}
	}

	// Otherwise, we know that we want to add an import instead of the CallExpression, but depending on the context of the CallExpression, we may
	// or may not import specific Named Exports, the Default Export, or the entire namespace.

	// Find the first Element- or PropertyAccessExpression that wraps the require(...) call, whatever it is.
	// That means that if it is wrapped in 'require(...)["foo"].bar', then the ElementAccessExpression will be matched first
	const elementOrPropertyAccessExpressionParent = findNodeUp<PropertyAccessExpression | ElementAccessExpression>(
		node,
		child => isElementAccessExpression(child) || isPropertyAccessExpression(child),
		isStatementOrDeclaration
	);

	if (elementOrPropertyAccessExpressionParent != null) {
		// Try to evaluate the name or argument expression, depending on the kind of node
		let rightValue: string | undefined;

		// If it is a PropertyAccessExpression, the name will always be an identifier
		if (isPropertyAccessExpression(elementOrPropertyAccessExpressionParent)) {
			rightValue = elementOrPropertyAccessExpressionParent.name.text;
		} else {
			// Otherwise, the argument may be any kind of expression. Try to evaluate it to a string literal if possible
			if (isStringLiteralLike(elementOrPropertyAccessExpressionParent.argumentExpression)) {
				rightValue = elementOrPropertyAccessExpressionParent.argumentExpression.text;
			}
		}

		// The argumentExpression or name matched a string, use that as a candidate for a lookup binding
		if (rightValue != null) {
			// If the module doesn't include a named export with a name matching the right value,
			// we should instead import the default export if it has any (otherwise we'll use a Namespace import) and replace the CallExpression with an identifier for it
			if (!moduleExports.namedExports.has(rightValue)) {
				let identifier: Identifier;

				// If the default export is already imported, get the local binding name for it and create an identifier for it
				// rather than generating a new unnecessary import
				if (moduleExports.hasDefaultExport && context.hasLocalForDefaultImportFromModule(moduleSpecifier)) {
					identifier = createIdentifier(context.getLocalForDefaultImportFromModule(moduleSpecifier)!);
				}

				// If the namespace is already imported, get the local binding name for it and create an identifier for it
				// rather than generating a new unnecessary import
				else if (!moduleExports.hasDefaultExport && context.hasLocalForNamespaceImportFromModule(moduleSpecifier)) {
					identifier = createIdentifier(context.getLocalForNamespaceImportFromModule(moduleSpecifier)!);
				} else {
					identifier = createIdentifier(context.getFreeIdentifier(generateNameFromModuleSpecifier(moduleSpecifier)));
					context.addImport(
						createImportDeclaration(
							undefined,
							undefined,

							moduleExports.hasDefaultExport
								? // Import the default if it has any (or if we don't know if it has)
								  createImportClause(identifier, undefined)
								: // Otherwise, import the entire namespace
								  createImportClause(undefined, createNamespaceImport(identifier)),
							createStringLiteral(moduleSpecifier)
						)
					);
				}

				// Replace the CallExpression by an ObjectLiteral that can be accessed by the wrapping Element- or PropertyAccessExpression
				return createObjectLiteral([
					identifier.text !== rightValue ? createPropertyAssignment(rightValue, createIdentifier(identifier.text)) : createShorthandPropertyAssignment(createIdentifier(identifier.text))
				]);
			}

			// Otherwise, use the right value as the ImportSpecifier for a new import.
			// Depending on the placement of the CallExpression, we may or may not need to
			// replace it with an identifier or remove it entirely in favor of the ImportDeclaration
			else {
				// The property to import will be equal to the right value
				const importBindingPropertyName = rightValue;

				let importBindingName: string;

				// If the default export is already imported, get the local binding name for it and create an identifier for it
				// rather than generating a new unnecessary import
				if (context.hasLocalForNamedImportPropertyNameFromModule(importBindingPropertyName, moduleSpecifier)) {
					importBindingName = context.getLocalForNamedImportPropertyNameFromModule(importBindingPropertyName, moduleSpecifier)!;
				}

				// If the namespace is already imported, get the local binding name for it and create an identifier for it
				// rather than generating a new unnecessary import
				else if (!moduleExports.hasDefaultExport && context.hasLocalForNamespaceImportFromModule(moduleSpecifier)) {
					importBindingName = context.getLocalForNamespaceImportFromModule(moduleSpecifier)!;
				} else {
					// If that binding isn't free within the context, import it as another local name
					importBindingName = context.isIdentifierFree(importBindingPropertyName) ? importBindingPropertyName : context.getFreeIdentifier(importBindingPropertyName);

					context.addImport(
						createImportDeclaration(
							undefined,
							undefined,
							createImportClause(
								undefined,
								createNamedImports([
									importBindingPropertyName === importBindingName
										? // If the property name is free within the context, don't alias the import
										  createImportSpecifier(undefined, createIdentifier(importBindingPropertyName))
										: // Otherwise, import it aliased by another name that is free within the context
										  createImportSpecifier(createIdentifier(importBindingPropertyName), createIdentifier(importBindingName))
								])
							),
							createStringLiteral(moduleSpecifier)
						)
					);
				}

				// If the 'require(...)[<something>]' or 'require(...).<something>' expression is part of an ExpressionStatement
				// and isn't part of another expression such as a BinaryExpression, only preserve the import.
				// Otherwise leave an ObjectLiteral that can be accessed by the wrapping Element- or PropertyAccessExpression
				if (expressionStatementParent == null) {
					return createObjectLiteral([
						importBindingName !== rightValue ? createPropertyAssignment(rightValue, createIdentifier(importBindingName)) : createShorthandPropertyAssignment(createIdentifier(importBindingName))
					]);
				} else {
					return undefined;
				}
			}
		}
	}

	// If no lookup binding candidate has been determined, it may be determined based on the parent VariableDeclaration,
	// if there is any.

	// Find the first VariableDeclaration that holds the require(...) call, if any.
	// For example, 'const foo = require(...)' would match the VariableDeclaration for 'foo'
	const variableDeclarationParent = findNodeUp(node, isVariableDeclaration, isStatement);

	if (variableDeclarationParent != null) {
		// If the VariableDeclaration is simply bound to a name, it doesn't tell us anything interesting.
		// Simply add an import for the default export - if it has any (otherwise we'll import the entire namespace), and
		// replace this CallExpression by an identifier for it
		if (isIdentifier(variableDeclarationParent.name)) {
			// If the default export is already imported, get the local binding name for it and create an identifier for it
			// rather than generating a new unnecessary import
			if (moduleExports.hasDefaultExport && context.hasLocalForDefaultImportFromModule(moduleSpecifier)) {
				const local = context.getLocalForDefaultImportFromModule(moduleSpecifier)!;
				return createIdentifier(local);
			}

			// If the namespace is already imported, get the local binding name for it and create an identifier for it
			// rather than generating a new unnecessary import
			else if (!moduleExports.hasDefaultExport && context.hasLocalForNamespaceImportFromModule(moduleSpecifier)) {
				const local = context.getLocalForNamespaceImportFromModule(moduleSpecifier)!;
				return createIdentifier(local);
			}

			// Otherwise proceed as planned
			else {
				const identifier = createIdentifier(context.getFreeIdentifier(generateNameFromModuleSpecifier(moduleSpecifier)));
				context.addImport(
					createImportDeclaration(
						undefined,
						undefined,

						moduleExports.hasDefaultExport
							? // Import the default if it has any (or if we don't know if it has)
							  createImportClause(identifier, undefined)
							: // Otherwise, import the entire namespace
							  createImportClause(undefined, createNamespaceImport(identifier)),
						createStringLiteral(moduleSpecifier)
					)
				);
				return identifier;
			}
		}

		// If the VariableDeclaration is a BindingPattern, it may mimic destructuring specific named exports.
		// For example, 'const {foo, bar} = require("./bar")' could import the named export bindings 'foo' and 'bar' from the module './bar'.
		// However, if as much as a single one of these elements don't directly match a named export, opt out of this behavior and instead
		// import the default export (if it has any, otherwise import the entire namespace).
		else if (isObjectBindingPattern(variableDeclarationParent.name)) {
			const importSpecifiers: ImportSpecifier[] = [];
			let skippedImportSpecifiers: ImportSpecifier[] = [];

			// Check each of the BindingElements
			for (const element of variableDeclarationParent.name.elements) {
				// If the property name isn't given, the name will always be an Identifier
				if (element.propertyName == null && isIdentifier(element.name)) {
					// If the module exports contains a named export matching the identifier name,
					// use that as an ImportSpecifier
					if (moduleExports.namedExports.has(element.name.text)) {
						// If the property has already been imported, don't add an import, but instead push to 'skippedImportSpecifiers'.
						if (context.hasLocalForNamedImportPropertyNameFromModule(element.name.text, moduleSpecifier)) {
							const local = context.getLocalForNamedImportPropertyNameFromModule(element.name.text, moduleSpecifier)!;
							skippedImportSpecifiers.push(
								local === element.name.text ? createImportSpecifier(undefined, createIdentifier(local)) : createImportSpecifier(createIdentifier(element.name.text), createIdentifier(local))
							);
						}

						// If the name is free, just import it as it is
						else if (context.isIdentifierFree(element.name.text)) {
							importSpecifiers.push(createImportSpecifier(undefined, createIdentifier(element.name.text)));
						} else {
							// Otherwise, import it under an aliased name
							const alias = context.getFreeIdentifier(element.name.text);
							importSpecifiers.push(createImportSpecifier(createIdentifier(element.name.text), createIdentifier(alias)));
						}
					}
				}

				// Otherwise, if it has a PropertyName,
				// It may be something like for example: '{foo: bar}' where 'foo' is the PropertyName and 'bar' is the name.
				// Of course it can get wilder than that, but for it to mimic ESM, we'll use at most the '{<propertyName>: <name>}' form
				// and preserve the remaining BindingName.
				// Since the ':bar' assignment comes from the VariableDeclaration that surrounds this CallExpression, we'll only
				// need to import the actual named export without considering the alias
				else if (element.propertyName != null && isIdentifier(element.propertyName)) {
					// If the name is free, just import it as it is
					if (context.isIdentifierFree(element.propertyName.text)) {
						importSpecifiers.push(createImportSpecifier(undefined, createIdentifier(element.propertyName.text)));
					} else {
						const alias = context.getFreeIdentifier(element.propertyName.text);
						importSpecifiers.push(createImportSpecifier(createIdentifier(element.propertyName.text), createIdentifier(alias)));
					}
				}
			}

			// If there aren't as many ImportSpecifiers as there are elements, opt out of this behavior and instead
			// import the default export (if it has any, otherwise import the entire namespace).
			if (importSpecifiers.length + skippedImportSpecifiers.length !== variableDeclarationParent.name.elements.length) {
				// If the default export is already imported, get the local binding name for it and create an identifier for it
				// rather than generating a new unnecessary import
				if (moduleExports.hasDefaultExport && context.hasLocalForDefaultImportFromModule(moduleSpecifier)) {
					const local = context.getLocalForDefaultImportFromModule(moduleSpecifier)!;
					return createIdentifier(local);
				}

				// If the namespace is already imported, get the local binding name for it and create an identifier for it
				// rather than generating a new unnecessary import
				else if (!moduleExports.hasDefaultExport && context.hasLocalForNamespaceImportFromModule(moduleSpecifier)) {
					const local = context.getLocalForNamespaceImportFromModule(moduleSpecifier)!;
					return createIdentifier(local);
				}

				// Otherwise proceed as planned
				else {
					const identifier = createIdentifier(context.getFreeIdentifier(generateNameFromModuleSpecifier(moduleSpecifier)));
					context.addImport(
						createImportDeclaration(
							undefined,
							undefined,

							moduleExports.hasDefaultExport
								? // Import the default if it has any (or if we don't know if it has)
								  createImportClause(identifier, undefined)
								: // Otherwise, import the entire namespace
								  createImportClause(undefined, createNamespaceImport(identifier)),
							createStringLiteral(moduleSpecifier)
						)
					);
					return identifier;
				}
			}

			// Otherwise, add an import for those specific, optionally aliased, named exports
			// and then replace this CallExpression with an Object literal that can be destructured
			else {
				if (importSpecifiers.length > 0) {
					context.addImport(createImportDeclaration(undefined, undefined, createImportClause(undefined, createNamedImports(importSpecifiers)), createStringLiteral(moduleSpecifier)));
				}

				return createObjectLiteral(
					[...importSpecifiers, ...skippedImportSpecifiers].map(specifier =>
						specifier.propertyName != null
							? createPropertyAssignment(specifier.propertyName.text, createIdentifier(specifier.name.text))
							: createShorthandPropertyAssignment(createIdentifier(specifier.name.text))
					)
				);
			}
		}
	}

	// Otherwise, check if the require(...) call is part of another CallExpression.
	// For example: 'myFunction(require(...)' or 'require(...)(...)'
	const callExpressionParent = findNodeUp(node, isCallExpression, isStatementOrDeclaration);

	// If it is wrapped in a CallExpression, import the default export if it has any (otherwise the entire namespace)
	// and replace the require() call by an identifier for it
	if (callExpressionParent != null) {
		// If the default export is already imported, get the local binding name for it and create an identifier for it
		// rather than generating a new unnecessary import
		if (moduleExports.hasDefaultExport && context.hasLocalForDefaultImportFromModule(moduleSpecifier)) {
			const local = context.getLocalForDefaultImportFromModule(moduleSpecifier)!;
			return createIdentifier(local);
		}

		// If the namespace is already imported, get the local binding name for it and create an identifier for it
		// rather than generating a new unnecessary import
		else if (!moduleExports.hasDefaultExport && context.hasLocalForNamespaceImportFromModule(moduleSpecifier)) {
			const local = context.getLocalForNamespaceImportFromModule(moduleSpecifier)!;
			return createIdentifier(local);
		}

		// Otherwise, proceed as planned
		else {
			const identifier = createIdentifier(context.getFreeIdentifier(generateNameFromModuleSpecifier(moduleSpecifier)));
			context.addImport(
				createImportDeclaration(
					undefined,
					undefined,

					moduleExports.hasDefaultExport
						? // Import the default if it has any (or if we don't know if it has)
						  createImportClause(identifier, undefined)
						: // Otherwise, import the entire namespace
						  createImportClause(undefined, createNamespaceImport(identifier)),
					createStringLiteral(moduleSpecifier)
				)
			);
			return identifier;
		}
	}

	if (context.debug) {
		throw new TypeError(`Could not handle require() call`);
	} else {
		return node;
	}
}